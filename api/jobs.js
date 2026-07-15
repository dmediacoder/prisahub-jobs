// Prisahub Jobs API - NHS England - Precise category matching
const CACHE = new Map();
const TTL = 30 * 60 * 1000;

function dec(s) {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&nbsp;/g,' ');
}
function clean(s) { return dec(s.replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim(); }
function getBand(s) { const m=s.match(/band\s*(\d+)/i); return m?parseInt(m[1]):undefined; }
function pick(block, dt) {
  const m=block.match(new RegExp(`<li[^>]*data-test="${dt}"[^>]*>([\\s\\S]*?)<\\/li>`,'i'));
  return m?clean(m[1]).replace(/^[A-Za-z ]+:\s*/,'').trim():'';
}

function parseNhs(html) {
  const jobs=[];
  const liRe=/<li[^>]*class="[^"]*\bsearch-result\b[^"]*"[^>]*>([\s\S]*?)(?=<li[^>]*class="[^"]*\bsearch-result\b|<\/ul)/g;
  let m;
  while((m=liRe.exec(html))!==null){
    const b=m[1];
    const tm=b.match(/<a[^>]*href="(\/candidate\/jobadvert\/[^"]+)"[^>]*data-test="search-result-job-title"[^>]*>([\s\S]*?)<\/a>/i)
           ||b.match(/<a[^>]*data-test="search-result-job-title"[^>]*href="(\/candidate\/jobadvert\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if(!tm) continue;
    const href=dec(tm[1]), title=clean(tm[2]), url=`https://www.jobs.nhs.uk${href}`;
    let org='NHS', loc='United Kingdom';
    const lb=b.match(/<div[^>]*data-test="search-result-location"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="nhsuk-grid-row/i);
    if(lb){
      const inn=lb[1];
      const om=inn.match(/<h3[^>]*>([\s\S]*?)<div[^>]*class="location-font-size"/i); if(om) org=clean(om[1]);
      const lm=inn.match(/<div[^>]*class="location-font-size"[^>]*>([\s\S]*?)<\/div>/i); if(lm) loc=clean(lm[1]).replace(/,\s*$/,'');
    }
    const salary=pick(b,'search-result-salary'), posted=pick(b,'search-result-publicationDate'),
          closing=pick(b,'search-result-closingDate'), contract=pick(b,'search-result-jobType'),
          pattern=pick(b,'search-result-workingPattern');
    const ref=href.match(/\/jobadvert\/([^?]+)/), id=ref?ref[1]:`${jobs.length}-${title.slice(0,20)}`;
    jobs.push({id,title,organisation:org,location:loc,
      salary:salary||undefined, band:getBand(`${title} ${salary}`),
      postedDate:posted||undefined, closingDate:closing||undefined,
      contractType:contract||undefined, workingPattern:pattern||undefined, url});
  }
  return jobs;
}

async function fetchPage(kw, loc, page=1, minSalary=0) {
  const p=new URLSearchParams({keyword:kw, language:'en', contractType:'Permanent'});
  if(loc) p.set('location', loc);
  if(page>1) p.set('page', String(page));
  if(minSalary>0){ p.set('payScheme','AfC'); p.set('salaryFrom',String(minSalary)); }
  try {
    const r=await fetch(`https://www.jobs.nhs.uk/candidate/search/results?${p}`,{
      headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
               'Accept':'text/html','Accept-Language':'en-GB,en;q=0.9'},
      signal:AbortSignal.timeout(12000)
    });
    if(!r.ok) return [];
    return parseNhs(await r.text());
  } catch(e){ return []; }
}

function isNhsOrg(org) {
  const o=org.toLowerCase();
  return o.includes('nhs')||o.includes('health board')||o.includes('hospital')||
         o.includes('trust')||o.includes('integrated care')||o.includes('ambulance')||
         o.includes('primary care')||o.includes('foundation');
}

function applyFilter(jobs, cat) {
  return jobs.filter(j=>{
    const tl=j.title.toLowerCase();
    const ct=(j.contractType||'').toLowerCase();
    const wp=(j.workingPattern||'').toLowerCase();
    if(!isNhsOrg(j.organisation)) return false;
    if(ct && !ct.includes('permanent')) return false;
    if(/\b(bank|fixed[\-\s]?term|locum|secondment|temporary|agency)\b/.test(tl+' '+ct)) return false;
    if(wp.includes('part time')||wp.includes('part-time')) return false;
    if(tl.includes('part time')||tl.includes('part-time')) return false;
    if(j.band!==undefined && j.band<=2) return false;
    if(cat.minBand && j.band!==undefined && j.band<cat.minBand) return false;
    if(cat.maxBand && j.band!==undefined && j.band>cat.maxBand) return false;
    if(cat.exLoc && j.location.toLowerCase().includes(cat.exLoc.toLowerCase())) return false;
    // EXACT title matching - title must contain at least one of the inc terms
    if(cat.inc?.length && !cat.inc.some(w=>tl.includes(w.toLowerCase()))) return false;
    // Title must NOT contain any exc terms
    if(cat.exc?.some(w=>tl.includes(w.toLowerCase()))) return false;
    return true;
  });
}

async function getJobs(cat) {
  const cached=CACHE.get(cat.id);
  if(cached && Date.now()-cached.at<TTL) return cached.jobs;
  try{
    const seen=new Set(), all=[];
    for(let pg=1;pg<=20;pg++){
      const jobs=await fetchPage(cat.kw, cat.loc||'', pg, cat.minSalary||0);
      if(!jobs.length) break;
      let added=0;
      for(const j of jobs){ if(seen.has(j.id)) continue; seen.add(j.id); all.push(j); added++; }
      if(!added) break;
    }
    const filtered=applyFilter(all,cat);
    CACHE.set(cat.id,{at:Date.now(),jobs:filtered});
    return filtered;
  }catch(e){
    const s=CACHE.get(cat.id); return s?s.jobs:[];
  }
}

// ── PRECISE TITLE LISTS PER CATEGORY ─────────────────────────

// SUPPORT WORKER - all variants, NO nurse/doctor/therapist titles
const SW_INC = [
  'healthcare support worker','hcsw','healthcare assistant','hca',
  'clinical support worker','nursing assistant','senior healthcare support worker',
  'ward support worker','patient support worker','patient care assistant',
  'assistant practitioner','therapy support worker',
  'mental health support worker','mental health healthcare assistant',
  'psychiatric support worker','psychiatric nursing assistant',
  'mental health clinical support worker','picu support worker',
  'crisis support worker','dementia support worker',
  'older adult mental health support worker','forensic mental health support worker',
  'learning disability support worker','learning disability healthcare assistant',
  'autism support worker','positive behaviour support worker',
  'behaviour support worker','intensive support worker',
  'community healthcare support worker','community support worker',
  'community rehabilitation support worker','district nursing support worker',
  'community mental health support worker','community falls support worker',
  'community hiv support worker','community health and wellbeing worker',
  'rehabilitation support worker','rehab therapy assistant',
  'occupational therapy assistant','occupational therapy support worker',
  'physiotherapy assistant','physiotherapy support worker',
  'speech and language therapy assistant','therapy assistant',
  'rehabilitation assistant',
  'maternity support worker','maternity care assistant',
  'neonatal support worker','neonatal healthcare assistant',
  'paediatric support worker','paediatric support','children\'s support worker',
  'nursery assistant',
  'theatre support worker','operating department support worker',
  'perioperative support worker','endoscopy support worker',
  'sterile services support worker',
  'emergency department support worker','a&e support worker',
  'acute medical unit support worker','critical care support worker',
  'icu support worker','hdu support worker',
  'renal support worker','dialysis support worker',
  'oncology support worker','cancer support worker',
  'chemotherapy support worker','cardiology support worker',
  'stroke support worker','neurology support worker',
  'respiratory support worker','orthopaedic support worker',
  'gastroenterology support worker','urology support worker',
  'ophthalmology support worker','ent support worker',
  'dermatology support worker','rheumatology support worker',
  'diabetes support worker','pain management support worker',
  'palliative care support worker','hospice support worker',
  'radiology support worker','imaging assistant',
  'mri assistant','ct assistant','ultrasound assistant',
  'phlebotomy support worker','laboratory support worker',
  'outpatient support worker','clinic support worker',
  'gp healthcare assistant','primary care support worker',
  'patient flow support worker','inpatient flow support worker',
  'patient experience support worker','discharge support worker',
  'admissions support worker','waiting list support worker',
  'care navigator','peer support worker','social prescribing link worker',
  'infection prevention support worker','tissue viability support worker',
  'tissue donation support worker','organ donation support worker',
  'research support worker','clinical trial support worker',
  'mortuary support worker','mortuary assistant',
  'decontamination support worker',
];
const SW_EXC = [
  'registered nurse','staff nurse','charge nurse','ward manager','ward sister',
  'nurse specialist','nurse consultant','nurse practitioner','advanced nurse',
  'community nurse','district nurse','school nurse',
  'midwife','midwifery','doctor','consultant','registrar','physician',
  'surgeon','pharmacist','radiographer','psychologist','paramedic',
  'sonographer','occupational therapist','physiotherapist','speech therapist',
  'social worker','manager','senior manager','team leader','lead',
];

// ADMIN - all variants, no clinical titles
const ADMIN_INC = [
  'administrative assistant','administrator','administration officer',
  'administrative officer','administrative coordinator','senior administrator',
  'administration team leader','office administrator','business administrator',
  'executive administrator','receptionist','medical receptionist',
  'senior receptionist','outpatient receptionist','ward receptionist',
  'clinic receptionist','health records receptionist','switchboard operator',
  'medical secretary','senior medical secretary','personal assistant',
  'executive assistant','team secretary','clinical secretary',
  'divisional secretary','directorate secretary','executive support officer',
  'patient services administrator','patient pathway coordinator',
  'patient pathway administrator','patient access administrator',
  'patient booking coordinator','appointments administrator',
  'admissions officer','admissions coordinator','waiting list coordinator',
  'referral coordinator','clinic coordinator','outpatient administrator',
  'theatre booking coordinator','cancer pathway coordinator',
  'health records clerk','health records officer','medical records officer',
  'medical records administrator','records coordinator',
  'hr administrator','workforce administrator','recruitment administrator',
  'medical staffing administrator','esr administrator','hr assistant',
  'people administrator','workforce officer','learning and development administrator',
  'temporary staffing administrator',
  'finance administrator','finance assistant','accounts assistant',
  'payroll administrator','procurement administrator','purchasing officer',
  'supplies administrator','accounts payable officer','accounts receivable officer',
  'information administrator','data administrator','information officer',
  'data quality officer','digital administrator','epr administrator',
  'clinical systems administrator',
  'governance administrator','quality administrator','risk administrator',
  'compliance administrator','audit administrator','complaints administrator',
  'patient safety administrator',
  'project administrator','project support officer','programme support officer',
  'pmo administrator','project coordinator','transformation administrator',
  'service improvement administrator',
  'operational administrator','operations coordinator','service administrator',
  'directorate administrator','department administrator','divisional administrator',
  'business support officer','business support administrator','operational support officer',
  'community administrator','mental health administrator','community team administrator',
  'crisis team administrator','camhs administrator','therapy administrator',
  'maternity administrator','neonatal administrator','paediatric administrator',
  'research administrator','clinical trials administrator',
  'medical education administrator','training administrator','education coordinator',
  'corporate administrator','board administrator','committee administrator',
  'corporate governance administrator','executive office administrator',
  'senior administrative officer','administration manager','office manager',
  'business manager','corporate services manager','service manager','general manager',
];
const ADMIN_EXC = [
  'nurse','nursing','doctor','consultant','registrar','physician','surgeon',
  'midwife','therapist','pharmacist','radiographer','psychologist','paramedic',
  'sonographer','support worker','healthcare assistant','hca',
];

// PROJECT MANAGER
const PM_INC = [
  'project support officer','project administrator','project coordinator',
  'pmo administrator','pmo support officer','programme support officer',
  'transformation support officer','change support officer',
  'business support officer (projects)','improvement support officer',
  'assistant project manager','junior project manager','project manager',
  'senior project manager','digital project manager','it project manager',
  'capital project manager','estates project manager','clinical project manager',
  'transformation project manager','workforce project manager',
  'hr project manager','epr project manager','service improvement project manager',
  'operational project manager','programme project manager','research project manager',
  'programme manager','senior programme manager','transformation programme manager',
  'digital programme manager','clinical programme manager',
  'workforce programme manager','strategic programme manager',
  'improvement programme manager','pmo programme manager','programme delivery manager',
  'pmo officer','pmo analyst','pmo coordinator','pmo manager','senior pmo manager',
  'portfolio office manager','head of pmo',
  'change manager','organisational change manager','transformation manager',
  'service transformation manager','improvement manager',
  'continuous improvement manager','quality improvement manager',
  'business change manager','transformation lead','change and engagement manager',
  'digital transformation manager','informatics project manager',
  'it programme manager','systems implementation manager',
  'epr implementation manager','digital delivery manager',
  'technical project manager','data project manager','cyber programme manager',
  'portfolio manager','head of programmes','head of transformation',
  'associate director of programmes','associate director of transformation',
  'deputy director of programmes','director of transformation','director of programmes',
];
const PM_EXC = [
  'nurse','doctor','support worker','healthcare assistant','administrator',
  'receptionist','secretary',
];

// BUSINESS ANALYST
const BA_INC = [
  'business analyst','senior business analyst','lead business analyst',
  'principal business analyst','junior business analyst','associate business analyst',
  'graduate business analyst','digital business analyst','clinical business analyst',
  'technical business analyst','it business analyst','systems business analyst',
  'data business analyst','information business analyst','healthcare business analyst',
  'digital transformation business analyst','transformation business analyst',
  'change business analyst','change analyst','transformation analyst',
  'digital analyst','digital improvement analyst','digital project analyst',
  'business change analyst','service transformation analyst',
  'service improvement analyst','transformation officer','digital programme analyst',
  'project analyst','programme analyst','pmo analyst','portfolio analyst',
  'project support analyst','programme support analyst',
  'benefits realisation analyst','project planning analyst','business improvement analyst',
  'clinical systems analyst','epr analyst','ehr analyst',
  'clinical informatics analyst','information systems analyst','application analyst',
  'systems analyst','digital systems analyst','configuration analyst','integration analyst',
  'quality improvement analyst','improvement analyst','continuous improvement analyst',
  'lean improvement analyst','service improvement officer','service improvement facilitator',
  'performance improvement analyst','operational improvement analyst',
  'workforce information analyst','workforce planning analyst','esr analyst',
  'hr systems analyst','people analytics analyst','hr data analyst',
  'workforce intelligence analyst','organisational development analyst',
  'business performance analyst','cost improvement analyst','commissioning analyst',
  'contract performance analyst','planning analyst',
  'digital programme officer','digital project officer',
  'process improvement analyst','operational business analyst',
  'operational excellence analyst','business process analyst',
  'process mapping analyst','business process improvement analyst','process design analyst',
  'automation analyst','robotic process automation analyst','rpa analyst',
  'power platform analyst','power bi analyst','data automation analyst',
  'digital automation analyst',
  'lead digital analyst','head of business analysis','head of informatics',
  'head of digital transformation','head of business intelligence',
];
const BA_EXC = [
  'nurse','doctor','support worker','healthcare assistant','project manager',
  'programme manager','data analyst','financial analyst',
];

// DATA ANALYST
const DATA_INC = [
  'data analyst','senior data analyst','lead data analyst','principal data analyst',
  'data engineer','analytics engineer','data warehouse developer',
  'data scientist','information analyst','reporting analyst',
  'performance analyst','workforce analyst','operational analyst',
  'service analyst','insight analyst','analytics officer',
  'bi developer','power bi developer','sql developer',
  'database administrator','dba',
  'workforce information analyst','workforce planning analyst',
  'people analytics analyst','hr data analyst','workforce intelligence analyst',
  'financial analyst','business performance analyst','commissioning analyst',
  'contract performance analyst',
];
const DATA_EXC = [
  'nurse','doctor','support worker','healthcare assistant',
  'business analyst','project manager','business intelligence analyst',
];

// BI ANALYST
const BI_INC = [
  'business intelligence analyst','bi analyst','senior bi analyst',
  'bi developer','business intelligence developer','bi lead','bi manager',
  'bi engineer','power bi analyst','tableau analyst','analytics engineer',
  'head of business intelligence',
];

// IT / ENGINEERING
const IT_INC = [
  'it support officer','it support technician','it service desk analyst',
  'it helpdesk analyst','desktop support engineer','field support engineer',
  'ict support officer','ict technician','infrastructure engineer',
  'infrastructure support engineer','infrastructure analyst',
  'technical support engineer','technical services engineer',
  'end user computing engineer','device deployment engineer',
  'systems support engineer','systems administrator',
  'windows systems administrator','linux systems administrator',
  'network administrator','server administrator','cloud administrator',
  'active directory administrator','microsoft 365 administrator',
  'azure administrator','vmware administrator',
  'network engineer','senior network engineer','network analyst',
  'network infrastructure engineer','wireless network engineer',
  'network operations engineer','telecommunications engineer',
  'unified communications engineer','voice engineer',
  'cloud engineer','azure cloud engineer','aws cloud engineer',
  'devops engineer','platform engineer','site reliability engineer',
  'sre','kubernetes engineer','infrastructure automation engineer',
  'ci/cd engineer','cloud infrastructure engineer',
  'software developer','software engineer','senior software engineer',
  'full stack developer','backend developer','frontend developer',
  '.net developer','java developer','python developer',
  'mobile application developer','web developer','integration developer',
  'api developer','it engineer','ict engineer',
  'cyber security analyst','cyber security engineer',
  'information security officer','security operations analyst',
  'security engineer','grc analyst','identity and access management engineer',
  'penetration tester','soc analyst',
  'digital project manager','digital programme manager','digital delivery manager',
  'digital transformation officer','digital product manager','product owner',
  'scrum master','agile delivery manager',
  'clinical systems analyst','epr systems analyst','ehr analyst',
  'clinical applications specialist','pacs administrator','ris administrator',
  'digital clinical support analyst','clinical informatics specialist',
  'biomedical engineer','clinical engineer','medical equipment engineer',
  'medical electronics engineer','biomedical engineering technician',
  'clinical technologist','medical device specialist','medical equipment technician',
  'diagnostic equipment engineer',
];
const IT_EXC = [
  'nurse','doctor','support worker','healthcare assistant',
  'project manager','programme manager','business analyst',
];

// FINANCE
const FIN_INC = [
  'finance officer','finance assistant','finance administrator',
  'finance manager','finance director','head of finance',
  'management accountant','financial accountant','senior accountant',
  'accounts payable officer','accounts receivable officer',
  'payroll administrator','payroll manager','payroll officer',
  'treasury officer','finance business partner','deputy director of finance',
  'financial analyst','financial planning analyst',
  'cost improvement analyst','financial reporting analyst',
];
const FIN_EXC = [
  'nurse','doctor','support worker','healthcare assistant',
  'project manager','business analyst','it',
];

// HR
const HR_INC = [
  'hr administrator','hr assistant','hr officer','hr advisor',
  'hr manager','hr director','hr business partner','hr lead',
  'human resources administrator','human resources assistant',
  'human resources officer','human resources advisor','human resources manager',
  'workforce administrator','workforce officer','workforce advisor',
  'workforce manager','people advisor','people partner','people manager',
  'resourcing advisor','resourcing manager','recruitment administrator',
  'recruitment advisor','recruitment manager','medical staffing administrator',
  'employee relations advisor','organisational development manager',
  'learning and development administrator','learning and development manager',
  'training administrator','training officer','esr administrator',
  'temporary staffing administrator','temporary staffing manager',
];
const HR_EXC = [
  'nurse','doctor','support worker','healthcare assistant',
  'project manager','business analyst','it',
];

// NURSING
const NURSE_INC = ['staff nurse','registered nurse','rgn'];
const NURSE_EXC = [
  'assistant','support worker','student','trainee','apprentice',
  'mental health','research','community','district','school',
  'specialist','consultant','practitioner','advanced',
];

const MH_NURSE_INC = [
  'mental health nurse','rmn','registered mental health',
  'psychiatric nurse','mental health practitioner',
];
const MH_NURSE_EXC = ['support worker','assistant','student','trainee'];

const RES_NURSE_INC = [
  'research nurse','clinical research nurse','senior research nurse',
  'research sister','research midwife',
];

// CLINICAL FELLOW
const FELLOW_INC = [
  'clinical fellow','junior clinical fellow','senior clinical fellow',
  'foundation year 1','foundation year 2','fy1','fy2','fy3',
  'st1','st2','st3','st4','st5','st6','st7','st8',
  'ct1','ct2','ct3',
  'trust doctor','specialty doctor','specialty registrar',
  'core trainee','associate specialist','sas doctor',
  'foundation doctor','foundation programme',
  'clinical scientist fellow',
];

// CLINICAL CODER
const CODER_INC = [
  'clinical coder','clinical coding','coding auditor',
  'clinical coding manager','senior clinical coder',
  'lead clinical coder','clinical coding officer',
  'clinical coding analyst','chief clinical coder',
];

// DIETICIAN
const DIET_INC = [
  'dietitian','dietician','community dietitian','specialist dietitian',
  'paediatric dietitian','senior dietitian','lead dietitian',
  'renal dietitian','oncology dietitian','clinical dietitian',
  'diabetes dietitian','critical care dietitian',
];

// MICROBIOLOGY
const MICRO_INC = [
  'biomedical scientist microbiology','microbiologist','microbiology scientist',
  'consultant microbiologist','microbiology laboratory',
  'clinical microbiologist','specialist biomedical scientist microbiology',
  'senior biomedical scientist microbiology','lead biomedical scientist microbiology',
  'microbiology',
];

// PHLEBOTOMIST
const PHLEB_INC = [
  'phlebotomist','phlebotomy','lead phlebotomist','senior phlebotomist',
  'phlebotomy team leader','chief phlebotomist','community phlebotomist',
  'phlebotomy supervisor','phlebotomy manager',
];

// RESEARCH ASSISTANT
const RES_INC = [
  'research assistant','research associate','research practitioner',
  'research officer','clinical research practitioner',
  'trial coordinator','study coordinator','research coordinator',
  'research fellow','research support officer',
  'clinical research assistant','principal investigator support',
];
const RES_EXC = ['research nurse','research midwife','research manager','research director'];

// SOCIAL WORKER
const SW2_INC = [
  'social worker','senior social worker','amhp',
  'approved mental health professional','children social worker',
  'adult social worker','community social worker','statutory social worker',
  'qualified social worker','practice educator','social work practitioner',
  'team manager social work',
];
const SW2_EXC = ['support worker','healthcare assistant','admin','administrator'];

// LOGISTICS
const LOG_INC = [
  'logistics manager','logistics officer','logistics coordinator',
  'supply chain manager','procurement officer','procurement manager',
  'procurement specialist','stores officer','supplies officer',
  'materials manager','inventory manager','transport manager',
  'fleet manager','distribution manager','warehousing manager',
  'stock controller','logistics',
];

// COORDINATOR
const COORD_INC = [
  'pathway coordinator','patient coordinator','care coordinator',
  'referral coordinator','discharge coordinator','admissions coordinator',
  'outpatient coordinator','scheduling coordinator',
  'appointments coordinator','waiting list coordinator',
  'access coordinator','service coordinator','booking coordinator',
  'clinical coordinator','patient flow coordinator',
  'elective care coordinator','cancer pathway coordinator',
  'theatre booking coordinator','clinic coordinator',
];

// ESTATES
const EST_INC = [
  'estates assistant','estates administrator','estates officer',
  'assistant estates officer','estates coordinator','estates support officer',
  'property assistant','maintenance coordinator','facilities officer',
  'facilities coordinator','estates manager','assistant estates manager',
  'estates operations manager','estates maintenance manager',
  'building services manager','property manager','facilities manager',
  'compliance manager','contracts manager','engineering manager',
  'hard fm manager','maintenance manager','senior estates manager',
  'head of estates','head of property','estates programme manager',
  'capital projects manager','capital development manager',
  'estate development manager','operational estates manager',
  'infrastructure manager','engineering services manager',
  'mechanical and electrical manager','strategic estates manager',
  'asset manager','associate director of estates','deputy director of estates',
  'director of estates','chief estates officer','director of capital projects',
  'estates compliance manager','fire safety manager','water safety manager',
  'authorised person','responsible person','health and safety manager',
  'energy manager','sustainability manager','environmental manager',
  'capital projects officer','capital project manager',
  'estates project manager','capital delivery manager',
  'construction project manager','property surveyor','estate surveyor',
  'commercial estates manager','lease manager','accommodation manager',
  'electrical engineering manager','mechanical engineering manager',
  'building services engineer','estates engineer','senior estates engineer',
];

// DEFINE ALL CATEGORIES
const CATS=[
  // ADMIN
  {id:'admin-out', label:'Admin Outside London', kw:'administrator', loc:'', exLoc:'london', minBand:4, minSalary:0, group:'Admin', inc:ADMIN_INC, exc:ADMIN_EXC},
  {id:'admin-lon', label:'Admin in London',       kw:'administrator', loc:'London', minBand:4, minSalary:0, group:'Admin', inc:ADMIN_INC, exc:ADMIN_EXC},

  // SUPPORT WORKERS
  {id:'sw-lon',   label:'Support Worker in London',      kw:'healthcare assistant', loc:'London',       minBand:3, minSalary:24071, group:'Support Worker', inc:SW_INC, exc:SW_EXC},
  {id:'sw-out',   label:'Support Worker Outside London', kw:'healthcare assistant', loc:'',   exLoc:'london', minBand:3, minSalary:24071, group:'Support Worker', inc:SW_INC, exc:SW_EXC},
  {id:'sw-wm',    label:'Support Worker West Midlands',  kw:'healthcare assistant', loc:'West Midlands', minBand:3, minSalary:24071, group:'Support Worker', inc:SW_INC, exc:SW_EXC},
  {id:'sw-wales', label:'Support Worker in Wales',       kw:'healthcare assistant', loc:'Wales',         minBand:3, minSalary:24071, group:'Support Worker', inc:SW_INC, exc:SW_EXC},
  {id:'sw-manc',  label:'Support Worker Manchester',     kw:'healthcare assistant', loc:'Manchester',    minBand:3, minSalary:24071, group:'Support Worker', inc:SW_INC, exc:SW_EXC},
  {id:'sw-wy',    label:'Support Worker W Yorkshire',    kw:'healthcare assistant', loc:'Leeds',         minBand:3, minSalary:24071, group:'Support Worker', inc:SW_INC, exc:SW_EXC},
  {id:'sw-ey',    label:'Support Worker E Yorkshire',    kw:'healthcare assistant', loc:'Hull',          minBand:3, minSalary:24071, group:'Support Worker', inc:SW_INC, exc:SW_EXC},

  // NURSING
  {id:'nurse',     label:'Staff Nurse',         kw:'staff nurse',        loc:'', minBand:5, maxBand:5, group:'Nursing', inc:NURSE_INC, exc:NURSE_EXC},
  {id:'mh-nurse',  label:'Mental Health Nurse', kw:'mental health nurse',loc:'', group:'Nursing', inc:MH_NURSE_INC, exc:MH_NURSE_EXC},
  {id:'res-nurse', label:'Research Nurse',      kw:'research nurse',     loc:'', group:'Nursing', inc:RES_NURSE_INC},

  // CLINICAL
  {id:'fellow',   label:'Clinical Fellow',     kw:'clinical fellow',    loc:'', group:'Clinical', inc:FELLOW_INC},
  {id:'coder',    label:'Clinical Coder',      kw:'clinical coder',     loc:'', group:'Clinical', inc:CODER_INC},
  {id:'diet',     label:'Dietician',           kw:'dietitian',          loc:'', group:'Clinical', inc:DIET_INC},
  {id:'micro',    label:'Microbiology',         kw:'microbiology',       loc:'', group:'Clinical', inc:MICRO_INC},
  {id:'phleb',    label:'Phlebotomist Leader', kw:'phlebotomist',       loc:'', group:'Clinical', inc:PHLEB_INC},
  {id:'res-asst', label:'Research Assistant',  kw:'research assistant', loc:'', group:'Clinical', inc:RES_INC, exc:RES_EXC},
  {id:'sw3',      label:'Social Worker',        kw:'social worker',      loc:'', group:'Clinical', inc:SW2_INC, exc:SW2_EXC},

  // PROFESSIONAL
  {id:'data',  label:'Data Analyst',       kw:'data analyst',              loc:'', group:'Professional', inc:DATA_INC, exc:DATA_EXC},
  {id:'bi',    label:'BI Analyst',         kw:'business intelligence analyst', loc:'', group:'Professional', inc:BI_INC},
  {id:'fin',   label:'Finance',            kw:'finance officer',           loc:'', group:'Professional', inc:FIN_INC, exc:FIN_EXC},
  {id:'hr',    label:'HR',                 kw:'human resources',           loc:'', group:'Professional', inc:HR_INC, exc:HR_EXC},
  {id:'it',    label:'IT / Engineering',   kw:'IT engineer',               loc:'', group:'Professional', inc:IT_INC, exc:IT_EXC},
  {id:'pm',    label:'Project Manager',    kw:'project manager',           loc:'', group:'Professional', inc:PM_INC, exc:PM_EXC},
  {id:'ba',    label:'Business Analyst',   kw:'business analyst',          loc:'', group:'Professional', inc:BA_INC, exc:BA_EXC},
  {id:'log',   label:'Logistics',          kw:'logistics',                 loc:'', group:'Professional', inc:LOG_INC},
  {id:'coord', label:'Coordinator',        kw:'pathway coordinator',       loc:'', group:'Professional', inc:COORD_INC},
  {id:'est',   label:'Estates',            kw:'estates manager',           loc:'', group:'Professional', inc:EST_INC},
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Cache-Control','public, max-age=1800');
  if(req.method==='OPTIONS'){res.status(200).end();return;}

  const {category, page=1}=req.query;
  const pg=parseInt(page), per=20;

  let targets=CATS;
  if(category && category!=='All'){
    targets=CATS.filter(c=>c.label===category||c.id===category);
    if(!targets.length) return res.status(404).json({error:'Unknown category'});
  }

  const all=[];
  await Promise.all(targets.map(async cat=>{
    const jobs=await getJobs(cat);
    jobs.forEach(j=>all.push({...j, category:cat.label, group:cat.group}));
  }));

  all.sort((a,b)=>{
    if(!a.postedDate&&!b.postedDate) return 0;
    if(!a.postedDate) return 1; if(!b.postedDate) return -1;
    return new Date(b.postedDate)-new Date(a.postedDate);
  });

  res.status(200).json({
    fetchedAt:new Date().toISOString(),
    total:all.length, page:pg,
    pages:Math.ceil(all.length/per),
    jobs:all.slice((pg-1)*per,pg*per)
  });
}
