// Prisahub Jobs API
// NHS England: scrapes jobs.nhs.uk (works perfectly)
// Scotland + Civil Service: returns direct search links (no scraping needed)

const CACHE = new Map();
const TTL_MS = 30 * 60 * 1000;

// ── HTML HELPERS ──────────────────────────────────────────────
function decodeEntities(s) {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&#x27;/g,"'")
          .replace(/&nbsp;/g,' ');
}
function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();
}
function extractBand(text) {
  const m = text.match(/band\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : undefined;
}
function pickAfterLabel(block, dataTest) {
  const re = new RegExp(`<li[^>]*data-test="${dataTest}"[^>]*>([\\s\\S]*?)<\\/li>`,'i');
  const m = block.match(re);
  if (!m) return '';
  return stripTags(m[1]).replace(/^[A-Za-z ]+:\s*/,'').trim();
}

// ── PARSE NHS JOBS HTML ───────────────────────────────────────
function parseNhsHtml(html) {
  const jobs = [];
  const liRe = /<li[^>]*class="[^"]*\bsearch-result\b[^"]*"[^>]*>([\s\S]*?)(?=<li[^>]*class="[^"]*\bsearch-result\b|<\/ul)/g;
  let match;
  while ((match = liRe.exec(html)) !== null) {
    const block = match[1];
    const tm = block.match(/<a[^>]*href="(\/candidate\/jobadvert\/[^"]+)"[^>]*data-test="search-result-job-title"[^>]*>([\s\S]*?)<\/a>/i)
            || block.match(/<a[^>]*data-test="search-result-job-title"[^>]*href="(\/candidate\/jobadvert\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!tm) continue;
    const href  = decodeEntities(tm[1]);
    const title = stripTags(tm[2]);
    const url   = `https://www.jobs.nhs.uk${href}`;

    let organisation = 'NHS', location = 'United Kingdom';
    const locBlock = block.match(/<div[^>]*data-test="search-result-location"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="nhsuk-grid-row/i);
    if (locBlock) {
      const inner = locBlock[1];
      const orgM  = inner.match(/<h3[^>]*>([\s\S]*?)<div[^>]*class="location-font-size"/i);
      if (orgM) organisation = stripTags(orgM[1]);
      const locM  = inner.match(/<div[^>]*class="location-font-size"[^>]*>([\s\S]*?)<\/div>/i);
      if (locM) location = stripTags(locM[1]).replace(/,\s*$/,'');
    }

    const salary         = pickAfterLabel(block,'search-result-salary');
    const postedDate     = pickAfterLabel(block,'search-result-publicationDate');
    const closingDate    = pickAfterLabel(block,'search-result-closingDate');
    const contractType   = pickAfterLabel(block,'search-result-jobType');
    const workingPattern = pickAfterLabel(block,'search-result-workingPattern');
    const band           = extractBand(`${title} ${salary}`);
    const refMatch       = href.match(/\/jobadvert\/([^?]+)/);
    const id             = refMatch ? refMatch[1] : `${jobs.length}-${title.slice(0,20)}`;

    jobs.push({ id, title, organisation, location,
      salary: salary||undefined, band,
      postedDate: postedDate||undefined, closingDate: closingDate||undefined,
      contractType: contractType||undefined, workingPattern: workingPattern||undefined, url });
  }
  return jobs;
}

// ── FETCH NHS ENGLAND ─────────────────────────────────────────
async function fetchNhsEngland(keyword, location, page=1) {
  const params = new URLSearchParams({ keyword, language:'en' });
  if (location) params.set('location', location);
  if (page > 1)  params.set('page', String(page));
  const res = await fetch(`https://www.jobs.nhs.uk/candidate/search/results?${params}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-GB,en;q=0.9',
    }
  });
  if (!res.ok) throw new Error(`NHS Jobs ${res.status}`);
  return parseNhsHtml(await res.text());
}

// ── APPLY NHS FILTERS ─────────────────────────────────────────
function isNHSOrg(org) {
  const o = org.toLowerCase();
  return o.includes('nhs') || o.includes('health board') || o.includes('hospital') ||
         o.includes('trust') || o.includes('integrated care') || o.includes('ambulance') ||
         o.includes('primary care');
}

function applyNhsFilters(jobs, opts) {
  return jobs.filter(j => {
    if (opts.minBand && j.band !== undefined && j.band < opts.minBand) return false;
    if (opts.maxBand && j.band !== undefined && j.band > opts.maxBand) return false;
    if (opts.excludeLocation && j.location.toLowerCase().includes(opts.excludeLocation.toLowerCase())) return false;
    const title = j.title.toLowerCase();
    if (opts.titleIncludes?.length && !opts.titleIncludes.some(t => title.includes(t.toLowerCase()))) return false;
    if (opts.titleExcludes?.some(t => title.includes(t.toLowerCase()))) return false;
    if (!isNHSOrg(j.organisation)) return false;
    const hay = `${j.title} ${j.contractType??''} ${j.workingPattern??''}`.toLowerCase();
    if (/\b(bank|fixed[\-\s]?term|locum|secondment|temporary|agency)\b/.test(hay)) return false;
    if (j.contractType && !j.contractType.toLowerCase().includes('permanent')) return false;
    return true;
  });
}

// ── SCOTLAND DIRECT LINKS ─────────────────────────────────────
// Scotland NHS blocks server requests so we return direct search links
// Users click the link and see live Scotland NHS jobs directly
function getScotlandLinks() {
  const base = 'https://apply.jobs.scot.nhs.uk/Home/Job';
  const perm = 'ContractType=Permanent';
  return [
    { id:'scot-admin-link',     category:'Admin Roles',          group:'Admin',
      title:'Browse Admin Jobs in NHS Scotland', organisation:'NHS Scotland',
      location:'Scotland', salary:undefined, band:undefined,
      contractType:'Permanent', postedDate:undefined, closingDate:undefined,
      url:`${base}?SearchTerm=administrator&${perm}` },
    { id:'scot-sw-link',        category:'Support Worker',        group:'Support Worker',
      title:'Browse Support Worker Jobs in NHS Scotland', organisation:'NHS Scotland',
      location:'Scotland', salary:undefined, band:'Band 3+',
      contractType:'Permanent', postedDate:undefined, closingDate:undefined,
      url:`${base}?SearchTerm=healthcare+assistant&${perm}` },
    { id:'scot-nurse-link',     category:'Staff Nurse',           group:'Nursing',
      title:'Browse Staff Nurse Jobs in NHS Scotland', organisation:'NHS Scotland',
      location:'Scotland', salary:undefined, band:'Band 5',
      contractType:'Permanent', postedDate:undefined, closingDate:undefined,
      url:`${base}?SearchTerm=staff+nurse&${perm}` },
    { id:'scot-mh-link',        category:'Mental Health Nurse',   group:'Nursing',
      title:'Browse Mental Health Nurse Jobs in NHS Scotland', organisation:'NHS Scotland',
      location:'Scotland', salary:undefined, band:undefined,
      contractType:'Permanent', postedDate:undefined, closingDate:undefined,
      url:`${base}?SearchTerm=mental+health+nurse&${perm}` },
    { id:'scot-fellow-link',    category:'Clinical Fellow',       group:'Clinical',
      title:'Browse Clinical Fellow Jobs in NHS Scotland', organisation:'NHS Scotland',
      location:'Scotland', salary:undefined, band:undefined,
      contractType:'Permanent', postedDate:undefined, closingDate:undefined,
      url:`${base}?SearchTerm=clinical+fellow&${perm}` },
    { id:'scot-sw2-link',       category:'Social Worker',         group:'Clinical',
      title:'Browse Social Worker Jobs in NHS Scotland', organisation:'NHS Scotland',
      location:'Scotland', salary:undefined, band:undefined,
      contractType:'Permanent', postedDate:undefined, closingDate:undefined,
      url:`${base}?SearchTerm=social+worker&${perm}` },
    { id:'scot-diet-link',      category:'Dietician',             group:'Clinical',
      title:'Browse Dietitian Jobs in NHS Scotland', organisation:'NHS Scotland',
      location:'Scotland', salary:undefined, band:undefined,
      contractType:'Permanent', postedDate:undefined, closingDate:undefined,
      url:`${base}?SearchTerm=dietitian&${perm}` },
    { id:'scot-micro-link',     category:'Microbiology',          group:'Clinical',
      title:'Browse Microbiology Jobs in NHS Scotland', organisation:'NHS Scotland',
      location:'Scotland', salary:undefined, band:undefined,
      contractType:'Permanent', postedDate:undefined, closingDate:undefined,
      url:`${base}?SearchTerm=microbiology&${perm}` },
    { id:'scot-phleb-link',     category:'Phlebotomist',          group:'Clinical',
      title:'Browse Phlebotomist Jobs in NHS Scotland', organisation:'NHS Scotland',
      location:'Scotland', salary:undefined, band:undefined,
      contractType:'Permanent', postedDate:undefined, closingDate:undefined,
      url:`${base}?SearchTerm=phlebotomist&${perm}` },
    { id:'scot-res-link',       category:'Research Assistant',    group:'Clinical',
      title:'Browse Research Jobs in NHS Scotland', organisation:'NHS Scotland',
      location:'Scotland', salary:undefined, band:undefined,
      contractType:'Permanent', postedDate:undefined, closingDate:undefined,
      url:`${base}?SearchTerm=research+assistant&${perm}` },
    { id:'scot-data-link',      category:'Data Analyst',          group:'Professional',
      title:'Browse Data Analyst Jobs in NHS Scotland', organisation:'NHS Scotland',
      location:'Scotland', salary:undefined, band:undefined,
      contractType:'Permanent', postedDate:undefined, closingDate:undefined,
      url:`${base}?SearchTerm=data+analyst&${perm}` },
    { id:'scot-bi-link',        category:'BI Analyst',            group:'Professional',
      title:'Browse BI Analyst Jobs in NHS Scotland', organisation:'NHS Scotland',
      location:'Scotland', salary:undefined, band:undefined,
      contractType:'Permanent', postedDate:undefined, closingDate:undefined,
      url:`${base}?SearchTerm=business+intelligence+analyst&${perm}` },
    { id:'scot-fin-link',       category:'Finance',               group:'Professional',
      title:'Browse Finance Jobs in NHS Scotland', organisation:'NHS Scotland',
      location:'Scotland', salary:undefined, band:undefined,
      contractType:'Permanent', postedDate:undefined, closingDate:undefined,
      url:`${base}?SearchTerm=finance+officer&${perm}` },
    { id:'scot-hr-link',        category:'HR',                    group:'Professional',
      title:'Browse HR Jobs in NHS Scotland', organisation:'NHS Scotland',
      location:'Scotland', salary:undefined, band:undefined,
      contractType:'Permanent', postedDate:undefined, closingDate:undefined,
      url:`${base}?SearchTerm=human+resources&${perm}` },
    { id:'scot-it-link',        category:'IT / Engineering',      group:'Professional',
      title:'Browse IT Jobs in NHS Scotland', organisation:'NHS Scotland',
      location:'Scotland', salary:undefined, band:undefined,
      contractType:'Permanent', postedDate:undefined, closingDate:undefined,
      url:`${base}?SearchTerm=IT+engineer&${perm}` },
    { id:'scot-pm-link',        category:'Project Manager',       group:'Professional',
      title:'Browse Project Manager Jobs in NHS Scotland', organisation:'NHS Scotland',
      location:'Scotland', salary:undefined, band:undefined,
      contractType:'Permanent', postedDate:undefined, closingDate:undefined,
      url:`${base}?SearchTerm=project+manager&${perm}` },
    { id:'scot-ba-link',        category:'Business Analyst',      group:'Professional',
      title:'Browse Business Analyst Jobs in NHS Scotland', organisation:'NHS Scotland',
      location:'Scotland', salary:undefined, band:undefined,
      contractType:'Permanent', postedDate:undefined, closingDate:undefined,
      url:`${base}?SearchTerm=business+analyst&${perm}` },
    { id:'scot-coord-link',     category:'Coordinator',           group:'Professional',
      title:'Browse Coordinator Jobs in NHS Scotland', organisation:'NHS Scotland',
      location:'Scotland', salary:undefined, band:undefined,
      contractType:'Permanent', postedDate:undefined, closingDate:undefined,
      url:`${base}?SearchTerm=pathway+coordinator&${perm}` },
  ];
}

// ── CIVIL SERVICE DIRECT LINKS ────────────────────────────────
function getCivilServiceLinks() {
  const base = 'https://www.civilservicejobs.service.gov.uk/csr/jobs.cgi?pagetype=jobsearch&keyword=';
  return [
    { id:'cs-eo-link',     category:'Admin Officer (EO)',         group:'Admin',
      title:'Browse Executive Officer (EO) Jobs', organisation:'Civil Service',
      location:'United Kingdom', salary:'£27,500 - £35,000', band:undefined, grade:'EO',
      contractType:'Permanent', url:`${base}executive+officer+EO` },
    { id:'cs-heo-link',    category:'Higher Admin Officer (HEO)', group:'Admin',
      title:'Browse Higher Executive Officer (HEO) Jobs', organisation:'Civil Service',
      location:'United Kingdom', salary:'£33,000 - £42,000', band:undefined, grade:'HEO',
      contractType:'Permanent', url:`${base}higher+executive+officer+HEO` },
    { id:'cs-seo-link',    category:'Senior Admin Officer (SEO)', group:'Admin',
      title:'Browse Senior Executive Officer (SEO) Jobs', organisation:'Civil Service',
      location:'United Kingdom', salary:'£40,000 - £52,000', band:undefined, grade:'SEO',
      contractType:'Permanent', url:`${base}senior+executive+officer+SEO` },
    { id:'cs-dev-link',    category:'Software Developer',         group:'Technology',
      title:'Browse Software Developer Jobs', organisation:'Civil Service',
      location:'United Kingdom', salary:undefined, band:undefined,
      contractType:'Permanent', url:`${base}software+developer` },
    { id:'cs-data-link',   category:'Data Analyst',               group:'Technology',
      title:'Browse Data Analyst Jobs', organisation:'Civil Service',
      location:'United Kingdom', salary:undefined, band:undefined,
      contractType:'Permanent', url:`${base}data+analyst` },
    { id:'cs-cyber-link',  category:'Cyber Security',             group:'Technology',
      title:'Browse Cyber Security Jobs', organisation:'Civil Service',
      location:'United Kingdom', salary:undefined, band:undefined,
      contractType:'Permanent', url:`${base}cyber+security` },
    { id:'cs-it-link',     category:'IT Support',                 group:'Technology',
      title:'Browse IT Support Jobs', organisation:'Civil Service',
      location:'United Kingdom', salary:undefined, band:undefined,
      contractType:'Permanent', url:`${base}IT+support+service+desk` },
    { id:'cs-dig-link',    category:'Digital & Technology',       group:'Technology',
      title:'Browse Digital & Technology Jobs', organisation:'Civil Service',
      location:'United Kingdom', salary:undefined, band:undefined,
      contractType:'Permanent', url:`${base}digital+product+manager` },
    { id:'cs-arch-link',   category:'IT Architecture',            group:'Technology',
      title:'Browse IT Architecture Jobs', organisation:'Civil Service',
      location:'United Kingdom', salary:undefined, band:undefined,
      contractType:'Permanent', url:`${base}solutions+architect` },
    { id:'cs-pm-link',     category:'Project Manager',            group:'Technology',
      title:'Browse Project Manager Jobs', organisation:'Civil Service',
      location:'United Kingdom', salary:undefined, band:undefined,
      contractType:'Permanent', url:`${base}project+manager` },
    { id:'cs-ba-link',     category:'Business Analyst',           group:'Technology',
      title:'Browse Business Analyst Jobs', organisation:'Civil Service',
      location:'United Kingdom', salary:undefined, band:undefined,
      contractType:'Permanent', url:`${base}business+analyst` },
  ];
}

const CX = ['nurse','nursing','doctor','consultant','registrar','physician',
  'surgeon','midwife','therapist','pharmacist','radiographer','psychologist','paramedic','sonographer'];

// ── NHS ENGLAND CATEGORIES ────────────────────────────────────
const NHS_CATEGORIES = [
  { id:'admin-outside-london', label:'Admin Outside London', keyword:'administrator', location:'', excludeLocation:'London', minBand:4, group:'Admin', titleIncludes:['admin','administrator','administrative','secretary','clerk','receptionist','coordinator','officer','assistant','booking','pathway','clerical','pa to'], titleExcludes:CX },
  { id:'admin-london', label:'Admin in London', keyword:'administrator', location:'London', minBand:4, group:'Admin', titleIncludes:['admin','administrator','administrative','secretary','clerk','receptionist','coordinator','officer','assistant','booking','pathway','clerical','pa to'], titleExcludes:CX },
  { id:'sw-london', label:'Support Worker in London', keyword:'support worker', location:'London', minBand:3, group:'Support Worker', titleIncludes:['support worker','healthcare support','health care support','care support','healthcare assistant','health care assistant','hca','hcsw','assistant practitioner'], titleExcludes:['registered nurse','staff nurse','charge nurse','ward manager','midwife','social worker'] },
  { id:'sw-outside-london', label:'Support Worker Outside London', keyword:'support worker', location:'', excludeLocation:'London', minBand:3, group:'Support Worker', titleIncludes:['support worker','healthcare support','health care support','care support','healthcare assistant','health care assistant','hca','hcsw','assistant practitioner'], titleExcludes:['registered nurse','staff nurse','charge nurse','ward manager','midwife','social worker'] },
  { id:'sw-west-midlands', label:'Support Worker West Midlands', keyword:'support worker', location:'West Midlands', minBand:3, group:'Support Worker', titleIncludes:['support worker','healthcare support','healthcare assistant','hca','assistant practitioner'], titleExcludes:['registered nurse','staff nurse','midwife','social worker'] },
  { id:'sw-wales', label:'Support Worker in Wales', keyword:'support worker', location:'Wales', minBand:3, group:'Support Worker', titleIncludes:['support worker','healthcare support','healthcare assistant','hca','assistant practitioner'], titleExcludes:['registered nurse','staff nurse','midwife','social worker'] },
  { id:'sw-manchester', label:'Support Worker Manchester', keyword:'support worker', location:'Manchester', minBand:3, group:'Support Worker', titleIncludes:['support worker','healthcare support','healthcare assistant','hca','assistant practitioner'], titleExcludes:['registered nurse','staff nurse','midwife','social worker'] },
  { id:'sw-west-yorkshire', label:'Support Worker W Yorkshire', keyword:'support worker', location:'West Yorkshire', minBand:3, group:'Support Worker', titleIncludes:['support worker','healthcare support','healthcare assistant','hca','assistant practitioner'], titleExcludes:['registered nurse','staff nurse','midwife','social worker'] },
  { id:'sw-east-yorkshire', label:'Support Worker E Yorkshire', keyword:'support worker', location:'East Yorkshire', minBand:3, group:'Support Worker', titleIncludes:['support worker','healthcare support','healthcare assistant','hca','assistant practitioner'], titleExcludes:['registered nurse','staff nurse','midwife','social worker'] },
  { id:'staff-nurse', label:'Staff Nurse', keyword:'staff nurse', location:'', minBand:5, maxBand:5, group:'Nursing', titleIncludes:['staff nurse','registered nurse','rgn','rmn'], titleExcludes:['assistant','support worker','student','trainee','apprentice','bank'] },
  { id:'mental-health-nurse', label:'Mental Health Nurse', keyword:'mental health nurse', location:'', group:'Nursing', titleIncludes:['mental health nurse','rmn','psychiatric nurse','mental health practitioner'], titleExcludes:['support worker','assistant','bank'] },
  { id:'research-nurse', label:'Research Nurse', keyword:'research nurse', location:'', group:'Nursing', titleIncludes:['research nurse','clinical research nurse','senior research nurse'] },
  { id:'clinical-fellow', label:'Clinical Fellow', keyword:'clinical fellow', location:'', group:'Clinical', titleIncludes:['clinical fellow','fellow','fy1','fy2','fy3','st1','st2','st3','st4','ct1','ct2','trust doctor','specialty doctor','specialty registrar','foundation year','junior clinical','sas doctor','associate specialist'] },
  { id:'clinical-coder', label:'Clinical Coder', keyword:'clinical coder', location:'', group:'Clinical', titleIncludes:['clinical coder','clinical coding','coding auditor','senior clinical coder','lead clinical coder'] },
  { id:'dietician', label:'Dietician', keyword:'dietitian', location:'', group:'Clinical', titleIncludes:['dietitian','dietician'] },
  { id:'microbiology', label:'Microbiology', keyword:'microbiology', location:'', group:'Clinical', titleIncludes:['microbiology','microbiologist'] },
  { id:'phlebotomist', label:'Phlebotomist Leader', keyword:'phlebotomist', location:'', group:'Clinical', titleIncludes:['phlebotomist','phlebotomy'] },
  { id:'research-assistant', label:'Research Assistant', keyword:'research assistant', location:'', group:'Clinical', titleIncludes:['research assistant','research associate','research practitioner','research officer','clinical research','trial coordinator','study coordinator'], titleExcludes:['research nurse'] },
  { id:'social-worker', label:'Social Worker', keyword:'social worker', location:'', group:'Clinical', titleIncludes:['social worker','amhp','approved mental health professional','practice educator'], titleExcludes:['support worker','healthcare assistant','admin'] },
  { id:'data-analyst', label:'Data Analyst', keyword:'data analyst', location:'', group:'Professional', titleIncludes:['data analyst','data analytics','information analyst','reporting analyst','data engineer','data scientist','performance analyst'], titleExcludes:['business intelligence','financial analyst'] },
  { id:'bi-analyst', label:'BI Analyst', keyword:'business intelligence analyst', location:'', group:'Professional', titleIncludes:['business intelligence','bi analyst','bi developer','bi lead','power bi','tableau'] },
  { id:'financial-analyst', label:'Financial Analyst', keyword:'financial analyst', location:'', group:'Professional', titleIncludes:['financial analyst','finance analyst','financial planning','fp&a','financial reporting'] },
  { id:'desk-analyst', label:'Desk Analyst', keyword:'service desk analyst', location:'', group:'Professional', titleIncludes:['desk analyst','service desk','helpdesk','1st line','2nd line','3rd line','it support analyst'] },
  { id:'finance', label:'Finance', keyword:'finance officer', location:'', group:'Professional', titleIncludes:['finance officer','finance manager','finance assistant','finance director','management accountant','financial accountant','senior accountant','accounts payable','accounts receivable','payroll','treasury','head of finance'], titleExcludes:['analyst','project manager'] },
  { id:'hr', label:'HR', keyword:'human resources', location:'', group:'Professional', titleIncludes:['hr advisor','hr officer','hr assistant','hr manager','hr director','hr business partner','human resources','people advisor','people partner','workforce','resourcing','recruitment advisor','employee relations','organisational development'] },
  { id:'it-engineering', label:'IT / Engineering', keyword:'IT engineer', location:'', group:'Professional', titleIncludes:['it engineer','network engineer','software developer','software engineer','infrastructure engineer','cyber security','cloud engineer','devops','solutions architect','technical architect','application developer','web developer','ict engineer'], titleExcludes:['clinical','biomedical','project manager'] },
  { id:'project-manager', label:'Project Manager', keyword:'project manager', location:'', group:'Professional', titleIncludes:['project manager','programme manager','project lead','project director','delivery manager','project officer'], titleExcludes:['nurse','doctor','support worker'] },
  { id:'business-analyst', label:'Business Analyst', keyword:'business analyst', location:'', group:'Professional', titleIncludes:['business analyst','systems analyst','process analyst','transformation analyst'], titleExcludes:['business intelligence','data analyst','financial analyst','project manager'] },
  { id:'logistics', label:'Logistics', keyword:'logistics', location:'', group:'Professional', titleIncludes:['logistics','supply chain','procurement','stores officer','transport manager','fleet manager','inventory','materials manager'] },
  { id:'coordinator', label:'Coordinator', keyword:'pathway coordinator', location:'', group:'Professional', titleIncludes:['pathway coordinator','patient coordinator','care coordinator','referral coordinator','discharge coordinator','admissions coordinator','outpatient coordinator','appointments coordinator','waiting list coordinator','access coordinator','service coordinator','booking coordinator','patient flow'] },
];

// ── FETCH AND CACHE NHS CATEGORY ──────────────────────────────
async function fetchNhsCategory(cat) {
  const cached = CACHE.get(cat.id);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.jobs;
  try {
    const seen = new Set(); const all = [];
    for (let p = 1; p <= 20; p++) {
      const pageJobs = await fetchNhsEngland(cat.keyword, cat.location||'', p);
      if (!pageJobs.length) break;
      let added = 0;
      for (const j of pageJobs) { if (seen.has(j.id)) continue; seen.add(j.id); all.push(j); added++; }
      if (!added) break;
    }
    const filtered = applyNhsFilters(all, cat);
    CACHE.set(cat.id, { at: Date.now(), jobs: filtered });
    return filtered;
  } catch(err) {
    const stale = CACHE.get(cat.id);
    return stale ? stale.jobs : [];
  }
}

// ── MAIN HANDLER ──────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Cache-Control','public, max-age=1800');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { category, tab='NHS', page=1 } = req.query;
  const pg = parseInt(page), perPage = 20;

  // ── SCOTLAND: return direct links ─────────────────────────
  if (tab === 'SCOTLAND') {
    let links = getScotlandLinks();
    if (category && category !== 'All') {
      links = links.filter(l => l.category === category);
    }
    const total = links.length;
    const jobs  = links.slice((pg-1)*perPage, pg*perPage);
    return res.status(200).json({ fetchedAt:new Date().toISOString(), total, page:pg, pages:Math.ceil(total/perPage), jobs, isLinks:true });
  }

  // ── CIVIL SERVICE: return direct links ────────────────────
  if (tab === 'CIVIL SERVICE') {
    let links = getCivilServiceLinks();
    if (category && category !== 'All') {
      links = links.filter(l => l.category === category);
    }
    const total = links.length;
    const jobs  = links.slice((pg-1)*perPage, pg*perPage);
    return res.status(200).json({ fetchedAt:new Date().toISOString(), total, page:pg, pages:Math.ceil(total/perPage), jobs, isLinks:true });
  }

  // ── NHS ENGLAND: live scrape ──────────────────────────────
  let targets = NHS_CATEGORIES;
  if (category && category !== 'All') {
    targets = targets.filter(c => c.label === category || c.id === category);
    if (!targets.length) return res.status(404).json({ error:'Unknown category' });
  }

  const allResults = [];
  await Promise.all(targets.map(async cat => {
    const jobs = await fetchNhsCategory(cat);
    jobs.forEach(j => allResults.push({...j, category:cat.label, group:cat.group}));
  }));

  allResults.sort((a,b) => {
    if (!a.postedDate && !b.postedDate) return 0;
    if (!a.postedDate) return 1;
    if (!b.postedDate) return -1;
    return new Date(b.postedDate) - new Date(a.postedDate);
  });

  const total = allResults.length;
  const jobs  = allResults.slice((pg-1)*perPage, pg*perPage);
  res.status(200).json({ fetchedAt:new Date().toISOString(), total, page:pg, pages:Math.ceil(total/perPage), jobs });
}
