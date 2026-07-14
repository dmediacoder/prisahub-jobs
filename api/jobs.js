// Prisahub Jobs API v4
// NHS England: live scrape from jobs.nhs.uk
// Scotland: live scrape from jobs.nhs.uk filtered to Scottish locations
// Civil Service: live scrape via allorigins proxy

const CACHE = new Map();
const TTL = 30 * 60 * 1000;

// ── HELPERS ───────────────────────────────────────────────────
function dec(s) {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&nbsp;/g,' ');
}
function clean(s) { return dec(s.replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim(); }
function band(s)  { const m=s.match(/band\s*(\d+)/i); return m?parseInt(m[1]):undefined; }
function pick(block, dt) {
  const m = block.match(new RegExp(`<li[^>]*data-test="${dt}"[^>]*>([\\s\\S]*?)<\\/li>`,'i'));
  return m ? clean(m[1]).replace(/^[A-Za-z ]+:\s*/,'').trim() : '';
}

// ── PARSE NHS JOBS HTML ───────────────────────────────────────
function parseNhs(html) {
  const jobs=[], liRe=/<li[^>]*class="[^"]*\bsearch-result\b[^"]*"[^>]*>([\s\S]*?)(?=<li[^>]*class="[^"]*\bsearch-result\b|<\/ul)/g;
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
    const refM=href.match(/\/jobadvert\/([^?]+)/), id=refM?refM[1]:`${jobs.length}-${title.slice(0,20)}`;
    jobs.push({id,title,organisation:org,location:loc,salary:salary||undefined,band:band(`${title} ${salary}`),
      postedDate:posted||undefined,closingDate:closing||undefined,contractType:contract||undefined,
      workingPattern:pattern||undefined,url});
  }
  return jobs;
}

// ── PARSE CIVIL SERVICE HTML ──────────────────────────────────
function parseCs(html, cat) {
  const jobs=[], seen=new Set();
  const boxes=[...html.matchAll(/<li[^>]*class="[^"]*search-results-job-box[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)].map(m=>m[1]);
  for(const b of boxes){
    const tm=b.match(/<a[^>]*href="([^"]*(?:job_id|jcode|vacancy|jobdetail)[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if(!tm) continue;
    const href=tm[1], title=clean(tm[2]);
    if(!title||title.length<4||title.length>200||seen.has(href)) continue;
    seen.add(href);
    const tl=title.toLowerCase();
    if(cat.inc?.length&&!cat.inc.some(w=>tl.includes(w))) continue;
    if(cat.exc?.some(w=>tl.includes(w))) continue;
    const url=href.startsWith('http')?href:`https://www.civilservicejobs.service.gov.uk${href}`;
    const dm=b.match(/<[^>]*class="[^"]*(?:department|employer)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i);
    const lm=b.match(/<[^>]*class="[^"]*location[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i);
    const sm=b.match(/£[\d,]+(?:\s*(?:to|-)\s*£[\d,]+)?/i);
    const gm=b.match(/\b(AA|AO|EO|HEO|SEO|Grade\s*[67]|SCS\s*[123])\b/i);
    const id=`cs-${jobs.length}-${title.slice(0,15).replace(/\W/g,'-')}`;
    jobs.push({id,title,organisation:dm?clean(dm[1]):'Civil Service',location:lm?clean(lm[1]):'United Kingdom',
      salary:sm?sm[0]:undefined,grade:gm?gm[1].toUpperCase():undefined,band:undefined,
      postedDate:undefined,closingDate:undefined,contractType:'Permanent',url});
  }
  return jobs;
}

// ── FETCH NHS ENGLAND ─────────────────────────────────────────
async function fetchNhsPage(kw, loc, page=1) {
  const p=new URLSearchParams({keyword:kw,language:'en'});
  if(loc) p.set('location',loc);
  if(page>1) p.set('page',String(page));
  const r=await fetch(`https://www.jobs.nhs.uk/candidate/search/results?${p}`,{
    headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36','Accept':'text/html','Accept-Language':'en-GB,en;q=0.9'}
  });
  if(!r.ok) throw new Error(`NHS ${r.status}`);
  return parseNhs(await r.text());
}

// ── FETCH CIVIL SERVICE VIA PROXY ─────────────────────────────
async function fetchCsPage(kw, page=1) {
  const target=`https://www.civilservicejobs.service.gov.uk/csr/jobs.cgi?pagetype=jobsearch&keyword=${encodeURIComponent(kw)}&page=${page}&pagesize=20`;
  const proxy=`https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`;
  const r=await fetch(proxy,{
    headers:{'User-Agent':'Mozilla/5.0 Chrome/120.0 Safari/537.36'},
    signal:AbortSignal.timeout(15000)
  });
  if(!r.ok) throw new Error(`CS proxy ${r.status}`);
  return await r.text();
}

// ── NHS FILTERS ───────────────────────────────────────────────
function isNhsOrg(org) {
  const o=org.toLowerCase();
  return o.includes('nhs')||o.includes('health board')||o.includes('hospital')||
         o.includes('trust')||o.includes('integrated care')||o.includes('ambulance')||
         o.includes('primary care');
}
const SCOTTISH=['edinburgh','glasgow','aberdeen','dundee','inverness','stirling','perth',
  'falkirk','kirkcaldy','paisley','livingston','hamilton','dunfermline','ayr','scotland',
  'scottish','highland','grampian','tayside','lothian','lanarkshire','ayrshire','fife',
  'borders','argyll','dumfries','galloway','orkney','shetland','forth valley'];

function nhsFilter(jobs, opts) {
  return jobs.filter(j=>{
    if(opts.minBand&&j.band!==undefined&&j.band<opts.minBand) return false;
    if(opts.maxBand&&j.band!==undefined&&j.band>opts.maxBand) return false;
    if(opts.exLoc&&j.location.toLowerCase().includes(opts.exLoc.toLowerCase())) return false;
    if(opts.scot&&!SCOTTISH.some(p=>j.location.toLowerCase().includes(p))) return false;
    const tl=j.title.toLowerCase();
    if(opts.inc?.length&&!opts.inc.some(w=>tl.includes(w))) return false;
    if(opts.exc?.some(w=>tl.includes(w))) return false;
    if(!isNhsOrg(j.organisation)) return false;
    const hay=`${j.title} ${j.contractType??''} ${j.workingPattern??''}`.toLowerCase();
    if(/\b(bank|fixed[\-\s]?term|locum|secondment|temporary|agency)\b/.test(hay)) return false;
    if(j.contractType&&!j.contractType.toLowerCase().includes('permanent')) return false;
    return true;
  });
}

// ── FETCH AND CACHE ───────────────────────────────────────────
async function getJobs(cat) {
  const cached=CACHE.get(cat.id);
  if(cached&&Date.now()-cached.at<TTL) return cached.jobs;
  try{
    const seen=new Set(), all=[];

    if(cat.source==='civil'){
      for(let p=1;p<=5;p++){
        const html=await fetchCsPage(cat.kw,p);
        const jobs=parseCs(html,cat);
        if(!jobs.length) break;
        let added=0;
        for(const j of jobs){if(seen.has(j.id)) continue;seen.add(j.id);all.push(j);added++;}
        if(!added) break;
      }
    } else if(cat.source==='scotland'){
      // Search multiple Scottish cities in parallel
      await Promise.all(['Edinburgh','Glasgow','Aberdeen','Dundee','Inverness'].map(async city=>{
        for(let p=1;p<=5;p++){
          const jobs=await fetchNhsPage(cat.kw,city,p);
          if(!jobs.length) break;
          let added=0;
          for(const j of jobs){if(seen.has(j.id)) continue;seen.add(j.id);all.push(j);added++;}
          if(!added) break;
        }
      }));
    } else {
      for(let p=1;p<=20;p++){
        const jobs=await fetchNhsPage(cat.kw,cat.loc||'',p);
        if(!jobs.length) break;
        let added=0;
        for(const j of jobs){if(seen.has(j.id)) continue;seen.add(j.id);all.push(j);added++;}
        if(!added) break;
      }
    }

    const filtered=cat.source==='civil'?all:nhsFilter(all,{
      minBand:cat.minBand,maxBand:cat.maxBand,exLoc:cat.exLoc,
      scot:cat.source==='scotland',inc:cat.inc,exc:cat.exc
    });
    CACHE.set(cat.id,{at:Date.now(),jobs:filtered});
    return filtered;
  }catch(e){
    const s=CACHE.get(cat.id); return s?s.jobs:[];
  }
}

// ── CATEGORY DEFINITIONS ──────────────────────────────────────
const CX=['nurse','nursing','doctor','consultant','registrar','physician','surgeon','midwife','therapist','pharmacist','radiographer','psychologist','paramedic','sonographer'];

const ALL_CATS = [
  // NHS ENGLAND
  {id:'nhs-admin-out',tab:'NHS',source:'nhs',label:'Admin Outside London',kw:'administrator',loc:'',exLoc:'London',minBand:4,group:'Admin',inc:['admin','administrator','administrative','secretary','clerk','receptionist','coordinator','officer','assistant','booking','pathway','clerical','pa to'],exc:CX},
  {id:'nhs-admin-lon',tab:'NHS',source:'nhs',label:'Admin in London',kw:'administrator',loc:'London',minBand:4,group:'Admin',inc:['admin','administrator','administrative','secretary','clerk','receptionist','coordinator','officer','assistant','booking','pathway','clerical','pa to'],exc:CX},
  {id:'nhs-sw-lon',tab:'NHS',source:'nhs',label:'Support Worker in London',kw:'support worker',loc:'London',minBand:3,group:'Support Worker',inc:['support worker','healthcare support','health care support','care support','healthcare assistant','health care assistant','hca','hcsw','assistant practitioner'],exc:['registered nurse','staff nurse','charge nurse','ward manager','midwife','social worker']},
  {id:'nhs-sw-out',tab:'NHS',source:'nhs',label:'Support Worker Outside London',kw:'support worker',loc:'',exLoc:'London',minBand:3,group:'Support Worker',inc:['support worker','healthcare support','health care support','care support','healthcare assistant','health care assistant','hca','hcsw','assistant practitioner'],exc:['registered nurse','staff nurse','charge nurse','ward manager','midwife','social worker']},
  {id:'nhs-sw-wm',tab:'NHS',source:'nhs',label:'Support Worker West Midlands',kw:'support worker',loc:'West Midlands',minBand:3,group:'Support Worker',inc:['support worker','healthcare support','healthcare assistant','hca','assistant practitioner'],exc:['registered nurse','staff nurse','midwife','social worker']},
  {id:'nhs-sw-wales',tab:'NHS',source:'nhs',label:'Support Worker in Wales',kw:'support worker',loc:'Wales',minBand:3,group:'Support Worker',inc:['support worker','healthcare support','healthcare assistant','hca','assistant practitioner'],exc:['registered nurse','staff nurse','midwife','social worker']},
  {id:'nhs-sw-manc',tab:'NHS',source:'nhs',label:'Support Worker Manchester',kw:'support worker',loc:'Manchester',minBand:3,group:'Support Worker',inc:['support worker','healthcare support','healthcare assistant','hca','assistant practitioner'],exc:['registered nurse','staff nurse','midwife','social worker']},
  {id:'nhs-sw-wy',tab:'NHS',source:'nhs',label:'Support Worker W Yorkshire',kw:'support worker',loc:'West Yorkshire',minBand:3,group:'Support Worker',inc:['support worker','healthcare support','healthcare assistant','hca','assistant practitioner'],exc:['registered nurse','staff nurse','midwife','social worker']},
  {id:'nhs-sw-ey',tab:'NHS',source:'nhs',label:'Support Worker E Yorkshire',kw:'support worker',loc:'East Yorkshire',minBand:3,group:'Support Worker',inc:['support worker','healthcare support','healthcare assistant','hca','assistant practitioner'],exc:['registered nurse','staff nurse','midwife','social worker']},
  {id:'nhs-nurse',tab:'NHS',source:'nhs',label:'Staff Nurse',kw:'staff nurse',loc:'',minBand:5,maxBand:5,group:'Nursing',inc:['staff nurse','registered nurse','rgn','rmn'],exc:['assistant','support worker','student','trainee','apprentice','bank']},
  {id:'nhs-mh-nurse',tab:'NHS',source:'nhs',label:'Mental Health Nurse',kw:'mental health nurse',loc:'',group:'Nursing',inc:['mental health nurse','rmn','psychiatric nurse','mental health practitioner'],exc:['support worker','assistant','bank']},
  {id:'nhs-res-nurse',tab:'NHS',source:'nhs',label:'Research Nurse',kw:'research nurse',loc:'',group:'Nursing',inc:['research nurse','clinical research nurse','senior research nurse']},
  {id:'nhs-fellow',tab:'NHS',source:'nhs',label:'Clinical Fellow',kw:'clinical fellow',loc:'',group:'Clinical',inc:['clinical fellow','fellow','fy1','fy2','fy3','st1','st2','st3','st4','ct1','ct2','trust doctor','specialty doctor','specialty registrar','foundation year','junior clinical','sas doctor','associate specialist']},
  {id:'nhs-coder',tab:'NHS',source:'nhs',label:'Clinical Coder',kw:'clinical coder',loc:'',group:'Clinical',inc:['clinical coder','clinical coding','coding auditor','senior clinical coder','lead clinical coder']},
  {id:'nhs-diet',tab:'NHS',source:'nhs',label:'Dietician',kw:'dietitian',loc:'',group:'Clinical',inc:['dietitian','dietician']},
  {id:'nhs-micro',tab:'NHS',source:'nhs',label:'Microbiology',kw:'microbiology',loc:'',group:'Clinical',inc:['microbiology','microbiologist']},
  {id:'nhs-phleb',tab:'NHS',source:'nhs',label:'Phlebotomist Leader',kw:'phlebotomist',loc:'',group:'Clinical',inc:['phlebotomist','phlebotomy']},
  {id:'nhs-res-asst',tab:'NHS',source:'nhs',label:'Research Assistant',kw:'research assistant',loc:'',group:'Clinical',inc:['research assistant','research associate','research practitioner','research officer','clinical research','trial coordinator','study coordinator'],exc:['research nurse']},
  {id:'nhs-sw3',tab:'NHS',source:'nhs',label:'Social Worker',kw:'social worker',loc:'',group:'Clinical',inc:['social worker','amhp','approved mental health professional','practice educator'],exc:['support worker','healthcare assistant','admin']},
  {id:'nhs-data',tab:'NHS',source:'nhs',label:'Data Analyst',kw:'data analyst',loc:'',group:'Professional',inc:['data analyst','data analytics','information analyst','reporting analyst','data engineer','data scientist','performance analyst'],exc:['business intelligence','financial analyst']},
  {id:'nhs-bi',tab:'NHS',source:'nhs',label:'BI Analyst',kw:'business intelligence analyst',loc:'',group:'Professional',inc:['business intelligence','bi analyst','bi developer','bi lead','power bi','tableau']},
  {id:'nhs-fa',tab:'NHS',source:'nhs',label:'Financial Analyst',kw:'financial analyst',loc:'',group:'Professional',inc:['financial analyst','finance analyst','financial planning','fp&a','financial reporting']},
  {id:'nhs-desk',tab:'NHS',source:'nhs',label:'Desk Analyst',kw:'service desk analyst',loc:'',group:'Professional',inc:['desk analyst','service desk','helpdesk','1st line','2nd line','3rd line','it support analyst']},
  {id:'nhs-fin',tab:'NHS',source:'nhs',label:'Finance',kw:'finance officer',loc:'',group:'Professional',inc:['finance officer','finance manager','finance assistant','finance director','management accountant','financial accountant','senior accountant','accounts payable','accounts receivable','payroll','treasury','head of finance'],exc:['analyst','project manager']},
  {id:'nhs-hr',tab:'NHS',source:'nhs',label:'HR',kw:'human resources',loc:'',group:'Professional',inc:['hr advisor','hr officer','hr assistant','hr manager','hr director','hr business partner','human resources','people advisor','people partner','workforce','resourcing','recruitment advisor','employee relations','organisational development']},
  {id:'nhs-it',tab:'NHS',source:'nhs',label:'IT / Engineering',kw:'IT engineer',loc:'',group:'Professional',inc:['it engineer','network engineer','software developer','software engineer','infrastructure engineer','cyber security','cloud engineer','devops','solutions architect','technical architect','application developer','web developer','ict engineer'],exc:['clinical','biomedical','project manager']},
  {id:'nhs-pm',tab:'NHS',source:'nhs',label:'Project Manager',kw:'project manager',loc:'',group:'Professional',inc:['project manager','programme manager','project lead','project director','delivery manager','project officer'],exc:['nurse','doctor','support worker']},
  {id:'nhs-ba',tab:'NHS',source:'nhs',label:'Business Analyst',kw:'business analyst',loc:'',group:'Professional',inc:['business analyst','systems analyst','process analyst','transformation analyst'],exc:['business intelligence','data analyst','financial analyst','project manager']},
  {id:'nhs-log',tab:'NHS',source:'nhs',label:'Logistics',kw:'logistics',loc:'',group:'Professional',inc:['logistics','supply chain','procurement','stores officer','transport manager','fleet manager','inventory','materials manager']},
  {id:'nhs-coord',tab:'NHS',source:'nhs',label:'Coordinator',kw:'pathway coordinator',loc:'',group:'Professional',inc:['pathway coordinator','patient coordinator','care coordinator','referral coordinator','discharge coordinator','admissions coordinator','outpatient coordinator','appointments coordinator','waiting list coordinator','access coordinator','service coordinator','booking coordinator','patient flow']},

  // SCOTLAND (same categories, Scottish locations only)
  {id:'scot-admin',tab:'SCOTLAND',source:'scotland',label:'Admin Roles',kw:'administrator',group:'Admin',inc:['admin','administrator','administrative','secretary','clerk','receptionist','coordinator','officer','assistant','booking','pathway','clerical'],exc:CX},
  {id:'scot-sw',tab:'SCOTLAND',source:'scotland',label:'Support Worker',kw:'healthcare assistant',minBand:3,group:'Support Worker',inc:['support worker','healthcare assistant','health care assistant','hca','hcsw','clinical support','assistant practitioner'],exc:['registered nurse','staff nurse','midwife','social worker']},
  {id:'scot-nurse',tab:'SCOTLAND',source:'scotland',label:'Staff Nurse',kw:'staff nurse',minBand:5,maxBand:5,group:'Nursing',inc:['staff nurse','registered nurse','rgn','rmn'],exc:['assistant','support worker','student','bank']},
  {id:'scot-mh',tab:'SCOTLAND',source:'scotland',label:'Mental Health Nurse',kw:'mental health nurse',group:'Nursing',inc:['mental health nurse','rmn','psychiatric nurse'],exc:['support worker','assistant','bank']},
  {id:'scot-fellow',tab:'SCOTLAND',source:'scotland',label:'Clinical Fellow',kw:'clinical fellow',group:'Clinical',inc:['clinical fellow','fellow','fy1','fy2','fy3','st1','st2','st3','trust doctor','specialty doctor','specialty registrar']},
  {id:'scot-sw2',tab:'SCOTLAND',source:'scotland',label:'Social Worker',kw:'social worker',group:'Clinical',inc:['social worker','amhp'],exc:['support worker','healthcare assistant']},
  {id:'scot-diet',tab:'SCOTLAND',source:'scotland',label:'Dietician',kw:'dietitian',group:'Clinical',inc:['dietitian','dietician']},
  {id:'scot-micro',tab:'SCOTLAND',source:'scotland',label:'Microbiology',kw:'microbiology',group:'Clinical',inc:['microbiology','microbiologist']},
  {id:'scot-phleb',tab:'SCOTLAND',source:'scotland',label:'Phlebotomist',kw:'phlebotomist',group:'Clinical',inc:['phlebotomist','phlebotomy']},
  {id:'scot-res',tab:'SCOTLAND',source:'scotland',label:'Research Assistant',kw:'research assistant',group:'Clinical',inc:['research assistant','research associate','research practitioner','clinical research','trial coordinator']},
  {id:'scot-data',tab:'SCOTLAND',source:'scotland',label:'Data Analyst',kw:'data analyst',group:'Professional',inc:['data analyst','data analytics','information analyst','reporting analyst','data engineer','data scientist']},
  {id:'scot-bi',tab:'SCOTLAND',source:'scotland',label:'BI Analyst',kw:'business intelligence analyst',group:'Professional',inc:['business intelligence','bi analyst','bi developer','power bi','tableau']},
  {id:'scot-fin',tab:'SCOTLAND',source:'scotland',label:'Finance',kw:'finance officer',group:'Professional',inc:['finance officer','finance manager','finance assistant','management accountant','financial accountant','payroll']},
  {id:'scot-hr',tab:'SCOTLAND',source:'scotland',label:'HR',kw:'human resources',group:'Professional',inc:['hr advisor','hr officer','hr assistant','hr manager','human resources','people advisor','workforce']},
  {id:'scot-it',tab:'SCOTLAND',source:'scotland',label:'IT / Engineering',kw:'IT engineer',group:'Professional',inc:['it engineer','network engineer','software developer','software engineer','infrastructure engineer','cyber security','devops','ict engineer'],exc:['clinical','biomedical']},
  {id:'scot-pm',tab:'SCOTLAND',source:'scotland',label:'Project Manager',kw:'project manager',group:'Professional',inc:['project manager','programme manager','project lead','project director','delivery manager','project officer']},
  {id:'scot-ba',tab:'SCOTLAND',source:'scotland',label:'Business Analyst',kw:'business analyst',group:'Professional',inc:['business analyst','systems analyst','process analyst','transformation analyst']},
  {id:'scot-coord',tab:'SCOTLAND',source:'scotland',label:'Coordinator',kw:'pathway coordinator',group:'Professional',inc:['pathway coordinator','patient coordinator','care coordinator','referral coordinator','discharge coordinator','admissions coordinator','outpatient coordinator','access coordinator']},

  // CIVIL SERVICE
  {id:'cs-eo',tab:'CIVIL SERVICE',source:'civil',label:'Admin Officer (EO)',kw:'executive officer EO administrative officer',group:'Admin',inc:['executive officer','administrative officer','admin officer','case officer','casework officer','processing officer','operations officer','correspondence officer'],exc:['senior executive officer','seo','higher executive','heo']},
  {id:'cs-heo',tab:'CIVIL SERVICE',source:'civil',label:'Higher Admin Officer (HEO)',kw:'higher executive officer HEO',group:'Admin',inc:['higher executive officer','heo','senior administrative','senior admin','senior case officer','policy officer','team manager'],exc:['senior executive officer','seo']},
  {id:'cs-seo',tab:'CIVIL SERVICE',source:'civil',label:'Senior Admin Officer (SEO)',kw:'senior executive officer SEO',group:'Admin',inc:['senior executive officer','seo','senior manager','senior policy','senior operations'],exc:['grade 6','grade 7','deputy director']},
  {id:'cs-dev',tab:'CIVIL SERVICE',source:'civil',label:'Software Developer',kw:'software developer engineer',group:'Technology',inc:['software developer','software engineer','developer','full stack','backend','frontend','devops','cloud engineer','web developer','application developer']},
  {id:'cs-data',tab:'CIVIL SERVICE',source:'civil',label:'Data Analyst',kw:'data analyst',group:'Technology',inc:['data analyst','data analytics','data engineer','data scientist','business intelligence','bi analyst','power bi','tableau','reporting analyst','information analyst']},
  {id:'cs-cyber',tab:'CIVIL SERVICE',source:'civil',label:'Cyber Security',kw:'cyber security',group:'Technology',inc:['cyber security','cybersecurity','information security','security analyst','security engineer','soc analyst','penetration tester','security architect']},
  {id:'cs-it',tab:'CIVIL SERVICE',source:'civil',label:'IT Support',kw:'IT support service desk',group:'Technology',inc:['it support','ict support','service desk','helpdesk','desktop support','1st line','2nd line','infrastructure engineer','network engineer','systems administrator']},
  {id:'cs-dig',tab:'CIVIL SERVICE',source:'civil',label:'Digital & Technology',kw:'digital technology product manager',group:'Technology',inc:['digital','product manager','product owner','delivery manager','agile','ux designer','user researcher','interaction designer','content designer','ddat']},
  {id:'cs-arch',tab:'CIVIL SERVICE',source:'civil',label:'IT Architecture',kw:'solutions architect enterprise architect',group:'Technology',inc:['architect','solutions architect','enterprise architect','technical architect','cloud architect','security architect']},
  {id:'cs-pm',tab:'CIVIL SERVICE',source:'civil',label:'Project Manager',kw:'project manager programme manager',group:'Technology',inc:['project manager','programme manager','project lead','delivery manager','project officer','pmo','portfolio manager']},
  {id:'cs-ba',tab:'CIVIL SERVICE',source:'civil',label:'Business Analyst',kw:'business analyst',group:'Technology',inc:['business analyst','systems analyst','process analyst','transformation analyst','change analyst']},
];

// ── MAIN HANDLER ──────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Cache-Control','public, max-age=1800');
  if(req.method==='OPTIONS'){res.status(200).end();return;}

  const {category,tab='NHS',page=1}=req.query;
  const pg=parseInt(page), per=20;

  let targets=ALL_CATS.filter(c=>c.tab===tab);
  if(category&&category!=='All'){
    targets=targets.filter(c=>c.label===category||c.id===category);
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
    total:all.length, page:pg,
    pages:Math.ceil(all.length/per),
    jobs:all.slice((pg-1)*per,pg*per)
  });
}
