// Prisahub Jobs API - NHS England
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
    jobs.push({id,title,organisation:org,location:loc,salary:salary||undefined,
      band:getBand(`${title} ${salary}`),postedDate:posted||undefined,
      closingDate:closing||undefined,contractType:contract||undefined,
      workingPattern:pattern||undefined,url});
  }
  return jobs;
}

async function fetchPage(kw, loc, page=1) {
  const p=new URLSearchParams({keyword:kw,language:'en'});
  if(loc) p.set('location',loc);
  if(page>1) p.set('page',String(page));
  const r=await fetch(`https://www.jobs.nhs.uk/candidate/search/results?${p}`,{
    headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36','Accept':'text/html','Accept-Language':'en-GB,en;q=0.9'}
  });
  if(!r.ok) throw new Error(`NHS ${r.status}`);
  return parseNhs(await r.text());
}

function isNhsOrg(org) {
  const o=org.toLowerCase();
  return o.includes('nhs')||o.includes('health board')||o.includes('hospital')||
         o.includes('trust')||o.includes('integrated care')||o.includes('ambulance')||
         o.includes('primary care');
}

// Location keywords for each region
const REGIONS = {
  'London':        ['london'],
  'West Midlands': ['birmingham','coventry','wolverhampton','leicester','derby','stoke','west midlands','sandwell','dudley','walsall'],
  'Wales':         ['cardiff','swansea','newport','wrexham','wales','welsh','aberystwyth','bangor'],
  'Manchester':    ['manchester','salford','stockport','oldham','rochdale','bolton','bury','wigan','tameside'],
  'West Yorkshire':['leeds','bradford','huddersfield','wakefield','halifax','calderdale','kirklees','west yorkshire'],
  'East Yorkshire':['hull','york','east yorkshire','humber','scarborough','beverley','grimsby'],
};

function inRegion(location, regionName) {
  if(!regionName) return true;
  const l = location.toLowerCase();
  const keys = REGIONS[regionName] || [];
  return keys.some(k => l.includes(k));
}

function filter(jobs, cat) {
  return jobs.filter(j=>{
    const tl = j.title.toLowerCase();
    const hay = `${j.title} ${j.contractType??''} ${j.workingPattern??''}`.toLowerCase();

    // 1. Reject bank, locum, fixed term, temporary, agency
    if(/\b(bank|fixed[\-\s]?term|locum|secondment|temporary|agency)\b/.test(hay)) return false;
    if(tl.includes('bank ')||tl.includes(' bank')) return false;

    // 2. Permanent only
    if(j.contractType && !j.contractType.toLowerCase().includes('permanent')) return false;

    // 3. No part time - reject ONLY if explicitly part time
    const wp = (j.workingPattern||'').toLowerCase();
    if(wp.includes('part time')||wp.includes('part-time')) return false;
    if(tl.includes('part time')||tl.includes('part-time')) return false;

    // 4. No Band 2 or below - but only reject if band is explicitly mentioned
    if(j.band!==undefined && j.band<=2) return false;

    // 5. Min band check - only apply if band is known
    if(cat.minBand && j.band!==undefined && j.band<cat.minBand) return false;

    // 6. Max band check
    if(cat.maxBand && j.band!==undefined && j.band>cat.maxBand) return false;

    // 7. Title must include category keywords
    if(cat.inc?.length && !cat.inc.some(w=>tl.includes(w))) return false;

    // 8. Title must not include blocked words
    if(cat.exc?.some(w=>tl.includes(w))) return false;

    // 9. Must be NHS organisation
    if(!isNhsOrg(j.organisation)) return false;

    // 10. Exclude specific location (e.g. not London)
    if(cat.exLoc && j.location.toLowerCase().includes(cat.exLoc.toLowerCase())) return false;

    // 11. Must be in target region (for location-specific categories)
    if(cat.region && !inRegion(j.location, cat.region)) return false;

    return true;
  });
}

async function getJobs(cat) {
  const cached=CACHE.get(cat.id);
  if(cached&&Date.now()-cached.at<TTL) return cached.jobs;
  try{
    const seen=new Set(), all=[];
    for(let p=1;p<=20;p++){
      // Search without location for region-specific SW categories
      // We filter by location ourselves which is more reliable
      const searchLoc = cat.useSearchLoc ? cat.loc : cat.searchLoc||cat.loc||'';
      const jobs=await fetchPage(cat.kw, searchLoc, p);
      if(!jobs.length) break;
      let added=0;
      for(const j of jobs){if(seen.has(j.id)) continue;seen.add(j.id);all.push(j);added++;}
      if(!added) break;
    }
    const filtered=filter(all,cat);
    CACHE.set(cat.id,{at:Date.now(),jobs:filtered});
    return filtered;
  }catch(e){
    const s=CACHE.get(cat.id); return s?s.jobs:[];
  }
}

const CX=['nurse','nursing','doctor','consultant','registrar','physician','surgeon',
  'midwife','therapist','pharmacist','radiographer','psychologist','paramedic','sonographer'];

const SW_INC=['support worker','healthcare support','health care support','care support',
  'healthcare assistant','health care assistant','hca','hcsw','assistant practitioner',
  'clinical support','theatre support','maternity support','surgical support'];
const SW_EXC=['registered nurse','staff nurse','charge nurse','ward manager','ward sister',
  'midwife','social worker','mental health worker','learning disability'];

const CATS=[
  // ADMIN
  {id:'admin-out',label:'Admin Outside London',kw:'administrator',loc:'',exLoc:'london',minBand:4,group:'Admin',
    inc:['admin','administrator','administrative','secretary','clerk','receptionist','coordinator','officer','assistant','booking','pathway','clerical','pa to'],exc:CX},
  {id:'admin-lon',label:'Admin in London',kw:'administrator',loc:'London',useSearchLoc:true,minBand:4,group:'Admin',
    inc:['admin','administrator','administrative','secretary','clerk','receptionist','coordinator','officer','assistant','booking','pathway','clerical','pa to'],exc:CX},

  // SUPPORT WORKERS - search broadly, filter by location ourselves
  {id:'sw-lon',label:'Support Worker in London',kw:'healthcare assistant',loc:'',region:'London',minBand:3,group:'Support Worker',inc:SW_INC,exc:SW_EXC},
  {id:'sw-out',label:'Support Worker Outside London',kw:'healthcare assistant',loc:'',exLoc:'london',minBand:3,group:'Support Worker',inc:SW_INC,exc:SW_EXC},
  {id:'sw-wm',label:'Support Worker West Midlands',kw:'healthcare assistant',loc:'West Midlands',useSearchLoc:true,minBand:3,group:'Support Worker',inc:SW_INC,exc:SW_EXC},
  {id:'sw-wales',label:'Support Worker in Wales',kw:'healthcare assistant',loc:'Wales',useSearchLoc:true,minBand:3,group:'Support Worker',inc:SW_INC,exc:SW_EXC},
  {id:'sw-manc',label:'Support Worker Manchester',kw:'healthcare assistant',loc:'Manchester',useSearchLoc:true,minBand:3,group:'Support Worker',inc:SW_INC,exc:SW_EXC},
  {id:'sw-wy',label:'Support Worker W Yorkshire',kw:'healthcare assistant',loc:'Leeds',useSearchLoc:true,minBand:3,group:'Support Worker',inc:SW_INC,exc:SW_EXC},
  {id:'sw-ey',label:'Support Worker E Yorkshire',kw:'healthcare assistant',loc:'Hull',useSearchLoc:true,minBand:3,group:'Support Worker',inc:SW_INC,exc:SW_EXC},

  // NURSING
  {id:'nurse',label:'Staff Nurse',kw:'staff nurse',loc:'',minBand:5,maxBand:5,group:'Nursing',
    inc:['staff nurse','registered nurse','rgn','rmn'],exc:['assistant','support worker','student','trainee','apprentice']},
  {id:'mh-nurse',label:'Mental Health Nurse',kw:'mental health nurse',loc:'',group:'Nursing',
    inc:['mental health nurse','rmn','psychiatric nurse','mental health practitioner'],exc:['support worker','assistant']},
  {id:'res-nurse',label:'Research Nurse',kw:'research nurse',loc:'',group:'Nursing',
    inc:['research nurse','clinical research nurse','senior research nurse']},

  // CLINICAL
  {id:'fellow',label:'Clinical Fellow',kw:'clinical fellow',loc:'',group:'Clinical',
    inc:['clinical fellow','fellow','fy1','fy2','fy3','st1','st2','st3','st4','ct1','ct2','trust doctor','specialty doctor','specialty registrar','foundation year','junior clinical','sas doctor','associate specialist']},
  {id:'coder',label:'Clinical Coder',kw:'clinical coder',loc:'',group:'Clinical',
    inc:['clinical coder','clinical coding','coding auditor','senior clinical coder','lead clinical coder']},
  {id:'diet',label:'Dietician',kw:'dietitian',loc:'',group:'Clinical',inc:['dietitian','dietician']},
  {id:'micro',label:'Microbiology',kw:'microbiology',loc:'',group:'Clinical',inc:['microbiology','microbiologist']},
  {id:'phleb',label:'Phlebotomist Leader',kw:'phlebotomist',loc:'',group:'Clinical',inc:['phlebotomist','phlebotomy']},
  {id:'res-asst',label:'Research Assistant',kw:'research assistant',loc:'',group:'Clinical',
    inc:['research assistant','research associate','research practitioner','research officer','clinical research','trial coordinator','study coordinator'],exc:['research nurse']},
  {id:'sw3',label:'Social Worker',kw:'social worker',loc:'',group:'Clinical',
    inc:['social worker','amhp','approved mental health professional','practice educator'],exc:['support worker','healthcare assistant','admin']},

  // PROFESSIONAL
  {id:'data',label:'Data Analyst',kw:'data analyst',loc:'',group:'Professional',
    inc:['data analyst','data analytics','information analyst','reporting analyst','data engineer','data scientist','performance analyst'],exc:['business intelligence','financial analyst']},
  {id:'bi',label:'BI Analyst',kw:'business intelligence analyst',loc:'',group:'Professional',
    inc:['business intelligence','bi analyst','bi developer','bi lead','power bi','tableau']},
  {id:'fa',label:'Financial Analyst',kw:'financial analyst',loc:'',group:'Professional',
    inc:['financial analyst','finance analyst','financial planning','fp&a','financial reporting']},
  {id:'desk',label:'Desk Analyst',kw:'service desk analyst',loc:'',group:'Professional',
    inc:['desk analyst','service desk','helpdesk','1st line','2nd line','3rd line','it support analyst']},
  {id:'fin',label:'Finance',kw:'finance officer',loc:'',group:'Professional',
    inc:['finance officer','finance manager','finance assistant','finance director','management accountant','financial accountant','senior accountant','accounts payable','accounts receivable','payroll','treasury','head of finance'],exc:['analyst','project manager']},
  {id:'hr',label:'HR',kw:'human resources',loc:'',group:'Professional',
    inc:['hr advisor','hr officer','hr assistant','hr manager','hr director','hr business partner','human resources','people advisor','people partner','workforce','resourcing','recruitment advisor','employee relations','organisational development']},
  {id:'it',label:'IT / Engineering',kw:'IT engineer',loc:'',group:'Professional',
    inc:['it engineer','network engineer','software developer','software engineer','infrastructure engineer','cyber security','cloud engineer','devops','solutions architect','technical architect','application developer','web developer','ict engineer'],exc:['clinical','biomedical','project manager']},
  {id:'pm',label:'Project Manager',kw:'project manager',loc:'',group:'Professional',
    inc:['project manager','programme manager','project lead','project director','delivery manager','project officer'],exc:['nurse','doctor','support worker']},
  {id:'ba',label:'Business Analyst',kw:'business analyst',loc:'',group:'Professional',
    inc:['business analyst','systems analyst','process analyst','transformation analyst'],exc:['business intelligence','data analyst','financial analyst','project manager']},
  {id:'log',label:'Logistics',kw:'logistics',loc:'',group:'Professional',
    inc:['logistics','supply chain','procurement','stores officer','transport manager','fleet manager','inventory','materials manager']},
  {id:'coord',label:'Coordinator',kw:'pathway coordinator',loc:'',group:'Professional',
    inc:['pathway coordinator','patient coordinator','care coordinator','referral coordinator','discharge coordinator','admissions coordinator','outpatient coordinator','appointments coordinator','waiting list coordinator','access coordinator','service coordinator','booking coordinator','patient flow']},
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Cache-Control','public, max-age=1800');
  if(req.method==='OPTIONS'){res.status(200).end();return;}

  const {category,page=1}=req.query;
  const pg=parseInt(page), per=20;

  let targets=CATS;
  if(category&&category!=='All'){
    targets=CATS.filter(c=>c.label===category||c.id===category);
    if(!targets.length) return res.status(404).json({error:'Unknown category'});
  }

  const all=[];
  await Promise.all(targets.map(async cat=>{
    const jobs=await getJobs(cat);
    jobs.forEach(j=>all.push({...j,category:cat.label,group:cat.group}));
  }));

  all.sort((a,b)=>{
    if(!a.postedDate&&!b.postedDate) return 0;
    if(!a.postedDate) return 1; if(!b.postedDate) return -1;
    return new Date(b.postedDate)-new Date(a.postedDate);
  });

  res.status(200).json({
    fetchedAt:new Date().toISOString(),
    total:all.length,page:pg,
    pages:Math.ceil(all.length/per),
    jobs:all.slice((pg-1)*per,pg*per)
  });
}
