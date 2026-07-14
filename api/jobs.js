// Prisahub Jobs API - Vercel Serverless Function
// NHS Jobs + Scotland NHS Jobs + Civil Service Jobs

const CACHE = new Map();
const TTL_MS = 30 * 60 * 1000;

// ── HTML PARSING HELPERS ──────────────────────────────────────
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

    let organisation = 'NHS Scotland', location = 'Scotland';
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

// ── PARSE CIVIL SERVICE JOBS HTML ─────────────────────────────
function parseCivilServiceHtml(html) {
  const jobs = [];
  // Civil Service Jobs uses different HTML structure
  // Job cards are in <li> with class "search-results-job-box"
  const liRe = /<li[^>]*class="[^"]*search-results-job-box[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = liRe.exec(html)) !== null) {
    const block = match[1];

    // Title + URL
    const tm = block.match(/<a[^>]*href="([^"]*\/jobs\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!tm) continue;
    const href  = tm[1];
    const title = stripTags(tm[2]);
    if (!title || title.length < 3) continue;
    const url = href.startsWith('http') ? href : `https://www.civilservicejobs.service.gov.uk${href}`;

    // Organisation
    const orgM = block.match(/<div[^>]*class="[^"]*department[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
              || block.match(/<span[^>]*class="[^"]*organisation[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const organisation = orgM ? stripTags(orgM[1]) : 'Civil Service';

    // Location
    const locM = block.match(/<div[^>]*class="[^"]*location[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
              || block.match(/<span[^>]*class="[^"]*location[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const location = locM ? stripTags(locM[1]) : 'United Kingdom';

    // Salary
    const salM = block.match(/<div[^>]*class="[^"]*salary[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
              || block.match(/£[\d,]+(?:\s*(?:to|-)\s*£[\d,]+)?/i);
    const salary = salM ? (typeof salM === 'string' ? salM : stripTags(salM[1])) : undefined;

    // Closing date
    const clM = block.match(/closing[^:]*:\s*([^<\n]{5,30})/i);
    const closingDate = clM ? clM[1].trim() : undefined;

    // Grade (EO, HEO, SEO etc)
    const gradeM = block.match(/\b(AA|AO|EO|HEO|SEO|Grade\s*[67]|SCS\s*[123]|G[67])\b/i);
    const grade = gradeM ? gradeM[1].toUpperCase() : undefined;

    const refMatch = href.match(/\/jobs\/(\d+)/);
    const id = refMatch ? `cs-${refMatch[1]}` : `cs-${jobs.length}-${title.slice(0,20)}`;

    jobs.push({ id, title, organisation, location,
      salary: salary||undefined, grade,
      postedDate: undefined, closingDate: closingDate||undefined,
      contractType: 'Permanent', workingPattern: undefined, url });
  }
  return jobs;
}

// ── FETCH NHS JOBS ────────────────────────────────────────────
async function fetchNhsSearch(keyword, location, page=1) {
  const params = new URLSearchParams({ keyword, language:'en' });
  if (location) params.set('location', location);
  if (page > 1)  params.set('page', String(page));
  const url = `https://www.jobs.nhs.uk/candidate/search/results?${params}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-GB,en;q=0.9',
    }
  });
  if (!res.ok) throw new Error(`NHS Jobs ${res.status}`);
  return parseNhsHtml(await res.text());
}

// ── FETCH CIVIL SERVICE JOBS ──────────────────────────────────
async function fetchCivilService(keyword, page=1) {
  const params = new URLSearchParams({
    'search[keyword]': keyword,
    'search[order_by_closing_date]': '0',
    'search[employment_types][]': 'permanent',
  });
  if (page > 1) params.set('page', String(page));
  const url = `https://www.civilservicejobs.service.gov.uk/csr/jobs.cgi?${params}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-GB,en;q=0.9',
    }
  });
  if (!res.ok) throw new Error(`Civil Service Jobs ${res.status}`);
  return parseCivilServiceHtml(await res.text());
}

// ── FILTERS ───────────────────────────────────────────────────
function applyFilters(jobs, opts) {
  return jobs.filter(j => {
    if (opts.minBand && j.band !== undefined && j.band < opts.minBand) return false;
    if (opts.maxBand && j.band !== undefined && j.band > opts.maxBand) return false;
    if (opts.excludeLocation && j.location.toLowerCase().includes(opts.excludeLocation.toLowerCase())) return false;

    const title = j.title.toLowerCase();
    if (opts.titleIncludes?.length) {
      if (!opts.titleIncludes.some(t => title.includes(t.toLowerCase()))) return false;
    }
    if (opts.titleExcludes?.some(t => title.includes(t.toLowerCase()))) return false;

    // NHS org check
    if (opts.source === 'nhs') {
      const org = j.organisation.toLowerCase();
      const isNHS = org.includes('nhs') || org.includes('health board') ||
                    org.includes('hospital') || org.includes('trust') ||
                    org.includes('integrated care') || org.includes('ambulance') ||
                    org.includes('ips employment') || org.includes('primary care') ||
                    org.includes('scotland') || org.includes('highland') ||
                    org.includes('grampian') || org.includes('lothian') ||
                    org.includes('tayside') || org.includes('fife') ||
                    org.includes('borders') || org.includes('forth valley') ||
                    org.includes('ayrshire') || org.includes('lanarkshire') ||
                    org.includes('greater glasgow') || org.includes('dumfries');
      if (!isNHS) return false;
    }

    // No bank/fixed-term/locum/temporary
    const hay = `${j.title} ${j.contractType??''} ${j.workingPattern??''}`.toLowerCase();
    if (/\b(bank|fixed[\-\s]?term|locum|secondment|temporary|agency)\b/.test(hay)) return false;
    if (j.contractType && !j.contractType.toLowerCase().includes('permanent')) return false;

    return true;
  });
}

const CLINICAL_EXCLUDES = ['nurse','nursing','doctor','consultant','registrar','physician',
  'surgeon','midwife','therapist','pharmacist','radiographer','psychologist','paramedic','sonographer'];

// ── ALL CATEGORIES ────────────────────────────────────────────
const CATEGORIES = [

  // ── NHS ENGLAND CATEGORIES ───────────────────────────────────
  { id:'admin-outside-london', label:'Admin Outside London', tab:'NHS', source:'nhs',
    keyword:'administrator', excludeLocation:'London', minBand:4, group:'Admin',
    titleIncludes:['admin','administrator','administrative','secretary','clerk','receptionist','coordinator','officer','assistant','booking','pathway','clerical','pa to'],
    titleExcludes:CLINICAL_EXCLUDES },
  { id:'admin-london', label:'Admin in London', tab:'NHS', source:'nhs',
    keyword:'administrator', location:'London', minBand:4, group:'Admin',
    titleIncludes:['admin','administrator','administrative','secretary','clerk','receptionist','coordinator','officer','assistant','booking','pathway','clerical','pa to'],
    titleExcludes:CLINICAL_EXCLUDES },
  { id:'sw-london', label:'Support Worker in London', tab:'NHS', source:'nhs',
    keyword:'support worker', location:'London', minBand:3, group:'Support Worker',
    titleIncludes:['support worker','healthcare support','health care support','care support','healthcare assistant','health care assistant','hca','hcsw','assistant practitioner'],
    titleExcludes:['registered nurse','staff nurse','charge nurse','ward manager','midwife','social worker'] },
  { id:'sw-outside-london', label:'Support Worker Outside London', tab:'NHS', source:'nhs',
    keyword:'support worker', excludeLocation:'London', minBand:3, group:'Support Worker',
    titleIncludes:['support worker','healthcare support','health care support','care support','healthcare assistant','health care assistant','hca','hcsw','assistant practitioner'],
    titleExcludes:['registered nurse','staff nurse','charge nurse','ward manager','midwife','social worker'] },
  { id:'sw-west-midlands', label:'Support Worker West Midlands', tab:'NHS', source:'nhs',
    keyword:'support worker', location:'West Midlands', minBand:3, group:'Support Worker',
    titleIncludes:['support worker','healthcare support','healthcare assistant','hca','assistant practitioner'],
    titleExcludes:['registered nurse','staff nurse','midwife','social worker'] },
  { id:'sw-wales', label:'Support Worker in Wales', tab:'NHS', source:'nhs',
    keyword:'support worker', location:'Wales', minBand:3, group:'Support Worker',
    titleIncludes:['support worker','healthcare support','healthcare assistant','hca','assistant practitioner'],
    titleExcludes:['registered nurse','staff nurse','midwife','social worker'] },
  { id:'sw-manchester', label:'Support Worker Manchester', tab:'NHS', source:'nhs',
    keyword:'support worker', location:'Manchester', minBand:3, group:'Support Worker',
    titleIncludes:['support worker','healthcare support','healthcare assistant','hca','assistant practitioner'],
    titleExcludes:['registered nurse','staff nurse','midwife','social worker'] },
  { id:'sw-west-yorkshire', label:'Support Worker W Yorkshire', tab:'NHS', source:'nhs',
    keyword:'support worker', location:'West Yorkshire', minBand:3, group:'Support Worker',
    titleIncludes:['support worker','healthcare support','healthcare assistant','hca','assistant practitioner'],
    titleExcludes:['registered nurse','staff nurse','midwife','social worker'] },
  { id:'sw-east-yorkshire', label:'Support Worker E Yorkshire', tab:'NHS', source:'nhs',
    keyword:'support worker', location:'East Yorkshire', minBand:3, group:'Support Worker',
    titleIncludes:['support worker','healthcare support','healthcare assistant','hca','assistant practitioner'],
    titleExcludes:['registered nurse','staff nurse','midwife','social worker'] },
  { id:'staff-nurse', label:'Staff Nurse', tab:'NHS', source:'nhs',
    keyword:'staff nurse', minBand:5, maxBand:5, group:'Nursing',
    titleIncludes:['staff nurse','registered nurse','rgn','rmn'],
    titleExcludes:['assistant','support worker','student','trainee','apprentice','bank'] },
  { id:'mental-health-nurse', label:'Mental Health Nurse', tab:'NHS', source:'nhs',
    keyword:'mental health nurse', group:'Nursing',
    titleIncludes:['mental health nurse','rmn','psychiatric nurse','mental health practitioner'],
    titleExcludes:['support worker','assistant','bank','locum'] },
  { id:'research-nurse', label:'Research Nurse', tab:'NHS', source:'nhs',
    keyword:'research nurse', group:'Nursing',
    titleIncludes:['research nurse','clinical research nurse','senior research nurse'],
    titleExcludes:['bank','locum'] },
  { id:'clinical-fellow', label:'Clinical Fellow', tab:'NHS', source:'nhs',
    keyword:'clinical fellow', group:'Clinical',
    titleIncludes:['clinical fellow','fellow','fy1','fy2','fy3','st1','st2','st3','st4','ct1','ct2','trust doctor','specialty doctor','specialty registrar','foundation year','junior clinical','sas doctor','associate specialist'] },
  { id:'clinical-coder', label:'Clinical Coder', tab:'NHS', source:'nhs',
    keyword:'clinical coder', group:'Clinical',
    titleIncludes:['clinical coder','clinical coding','coding auditor','clinical coding manager','senior clinical coder','lead clinical coder'] },
  { id:'dietician', label:'Dietician', tab:'NHS', source:'nhs',
    keyword:'dietitian', group:'Clinical',
    titleIncludes:['dietitian','dietician'] },
  { id:'microbiology', label:'Microbiology', tab:'NHS', source:'nhs',
    keyword:'microbiology', group:'Clinical',
    titleIncludes:['microbiology','microbiologist'] },
  { id:'phlebotomist', label:'Phlebotomist Leader', tab:'NHS', source:'nhs',
    keyword:'phlebotomist', group:'Clinical',
    titleIncludes:['phlebotomist','phlebotomy'] },
  { id:'research-assistant', label:'Research Assistant', tab:'NHS', source:'nhs',
    keyword:'research assistant', group:'Clinical',
    titleIncludes:['research assistant','research associate','research practitioner','research officer','clinical research','trial coordinator','study coordinator'],
    titleExcludes:['research nurse'] },
  { id:'social-worker', label:'Social Worker', tab:'NHS', source:'nhs',
    keyword:'social worker', group:'Clinical',
    titleIncludes:['social worker','amhp','approved mental health professional','practice educator'],
    titleExcludes:['support worker','healthcare assistant','admin'] },
  { id:'data-analyst', label:'Data Analyst', tab:'NHS', source:'nhs',
    keyword:'data analyst', group:'Professional',
    titleIncludes:['data analyst','data analytics','information analyst','reporting analyst','data engineer','data scientist','performance analyst'],
    titleExcludes:['business intelligence','financial analyst'] },
  { id:'bi-analyst', label:'BI Analyst', tab:'NHS', source:'nhs',
    keyword:'business intelligence analyst', group:'Professional',
    titleIncludes:['business intelligence','bi analyst','bi developer','bi lead','power bi','tableau'] },
  { id:'financial-analyst', label:'Financial Analyst', tab:'NHS', source:'nhs',
    keyword:'financial analyst', group:'Professional',
    titleIncludes:['financial analyst','finance analyst','financial planning','fp&a','financial reporting'] },
  { id:'desk-analyst', label:'Desk Analyst', tab:'NHS', source:'nhs',
    keyword:'service desk analyst', group:'Professional',
    titleIncludes:['desk analyst','service desk','helpdesk','1st line','2nd line','3rd line','it support analyst'] },
  { id:'finance', label:'Finance', tab:'NHS', source:'nhs',
    keyword:'finance officer', group:'Professional',
    titleIncludes:['finance officer','finance manager','finance assistant','finance director','management accountant','financial accountant','senior accountant','accounts payable','accounts receivable','payroll','treasury','head of finance'],
    titleExcludes:['analyst','project manager'] },
  { id:'hr', label:'HR', tab:'NHS', source:'nhs',
    keyword:'human resources', group:'Professional',
    titleIncludes:['hr advisor','hr officer','hr assistant','hr manager','hr director','hr business partner','human resources','people advisor','people partner','workforce','resourcing','recruitment advisor','employee relations','organisational development'] },
  { id:'it-engineering', label:'IT / Engineering', tab:'NHS', source:'nhs',
    keyword:'IT engineer', group:'Professional',
    titleIncludes:['it engineer','network engineer','software developer','software engineer','infrastructure engineer','cyber security','cloud engineer','devops','solutions architect','technical architect','application developer','web developer','ict engineer'],
    titleExcludes:['clinical','biomedical','project manager'] },
  { id:'project-manager', label:'Project Manager', tab:'NHS', source:'nhs',
    keyword:'project manager', group:'Professional',
    titleIncludes:['project manager','programme manager','project lead','project director','delivery manager','project officer'],
    titleExcludes:['nurse','doctor','support worker'] },
  { id:'business-analyst', label:'Business Analyst', tab:'NHS', source:'nhs',
    keyword:'business analyst', group:'Professional',
    titleIncludes:['business analyst','systems analyst','process analyst','transformation analyst'],
    titleExcludes:['business intelligence','data analyst','financial analyst','project manager'] },
  { id:'logistics', label:'Logistics', tab:'NHS', source:'nhs',
    keyword:'logistics', group:'Professional',
    titleIncludes:['logistics','supply chain','procurement','stores officer','transport manager','fleet manager','inventory','materials manager'] },
  { id:'coordinator', label:'Coordinator', tab:'NHS', source:'nhs',
    keyword:'pathway coordinator', group:'Professional',
    titleIncludes:['pathway coordinator','patient coordinator','care coordinator','referral coordinator','discharge coordinator','admissions coordinator','outpatient coordinator','appointments coordinator','waiting list coordinator','access coordinator','service coordinator','booking coordinator','patient flow'] },

  // ── SCOTLAND NHS CATEGORIES ───────────────────────────────────
  { id:'scot-admin', label:'Admin Roles', tab:'SCOTLAND', source:'nhs',
    keyword:'administrator scotland', location:'Scotland', minBand:4, group:'Admin',
    titleIncludes:['admin','administrator','administrative','secretary','clerk','receptionist','coordinator','officer','assistant','booking','pathway','clerical','pa to'],
    titleExcludes:CLINICAL_EXCLUDES },
  { id:'scot-sw', label:'Support Worker', tab:'SCOTLAND', source:'nhs',
    keyword:'support worker', location:'Scotland', minBand:3, group:'Support Worker',
    titleIncludes:['support worker','healthcare support','healthcare assistant','hca','hcsw','assistant practitioner'],
    titleExcludes:['registered nurse','staff nurse','midwife','social worker'] },
  { id:'scot-staff-nurse', label:'Staff Nurse', tab:'SCOTLAND', source:'nhs',
    keyword:'staff nurse', location:'Scotland', minBand:5, maxBand:5, group:'Nursing',
    titleIncludes:['staff nurse','registered nurse','rgn','rmn'],
    titleExcludes:['assistant','support worker','student','bank'] },
  { id:'scot-mh-nurse', label:'Mental Health Nurse', tab:'SCOTLAND', source:'nhs',
    keyword:'mental health nurse', location:'Scotland', group:'Nursing',
    titleIncludes:['mental health nurse','rmn','psychiatric nurse','mental health practitioner'],
    titleExcludes:['support worker','assistant','bank'] },
  { id:'scot-clinical-fellow', label:'Clinical Fellow', tab:'SCOTLAND', source:'nhs',
    keyword:'clinical fellow', location:'Scotland', group:'Clinical',
    titleIncludes:['clinical fellow','fellow','fy1','fy2','fy3','st1','st2','st3','trust doctor','specialty doctor','specialty registrar','foundation year','sas doctor'] },
  { id:'scot-social-worker', label:'Social Worker', tab:'SCOTLAND', source:'nhs',
    keyword:'social worker', location:'Scotland', group:'Clinical',
    titleIncludes:['social worker','amhp','approved mental health professional'],
    titleExcludes:['support worker','healthcare assistant'] },
  { id:'scot-dietician', label:'Dietician', tab:'SCOTLAND', source:'nhs',
    keyword:'dietitian', location:'Scotland', group:'Clinical',
    titleIncludes:['dietitian','dietician'] },
  { id:'scot-microbiology', label:'Microbiology', tab:'SCOTLAND', source:'nhs',
    keyword:'microbiology', location:'Scotland', group:'Clinical',
    titleIncludes:['microbiology','microbiologist'] },
  { id:'scot-phlebotomist', label:'Phlebotomist', tab:'SCOTLAND', source:'nhs',
    keyword:'phlebotomist', location:'Scotland', group:'Clinical',
    titleIncludes:['phlebotomist','phlebotomy'] },
  { id:'scot-research', label:'Research Assistant', tab:'SCOTLAND', source:'nhs',
    keyword:'research assistant', location:'Scotland', group:'Clinical',
    titleIncludes:['research assistant','research associate','research practitioner','clinical research','trial coordinator'] },
  { id:'scot-data-analyst', label:'Data Analyst', tab:'SCOTLAND', source:'nhs',
    keyword:'data analyst', location:'Scotland', group:'Professional',
    titleIncludes:['data analyst','data analytics','information analyst','reporting analyst','data engineer','data scientist'] },
  { id:'scot-bi', label:'BI Analyst', tab:'SCOTLAND', source:'nhs',
    keyword:'business intelligence analyst', location:'Scotland', group:'Professional',
    titleIncludes:['business intelligence','bi analyst','bi developer','power bi','tableau'] },
  { id:'scot-finance', label:'Finance', tab:'SCOTLAND', source:'nhs',
    keyword:'finance officer', location:'Scotland', group:'Professional',
    titleIncludes:['finance officer','finance manager','finance assistant','management accountant','financial accountant','payroll'] },
  { id:'scot-hr', label:'HR', tab:'SCOTLAND', source:'nhs',
    keyword:'human resources', location:'Scotland', group:'Professional',
    titleIncludes:['hr advisor','hr officer','hr assistant','hr manager','human resources','people advisor','workforce','resourcing'] },
  { id:'scot-it', label:'IT / Engineering', tab:'SCOTLAND', source:'nhs',
    keyword:'IT engineer', location:'Scotland', group:'Professional',
    titleIncludes:['it engineer','network engineer','software developer','software engineer','infrastructure engineer','cyber security','cloud engineer','devops','solutions architect','technical architect','ict engineer'],
    titleExcludes:['clinical','biomedical'] },
  { id:'scot-pm', label:'Project Manager', tab:'SCOTLAND', source:'nhs',
    keyword:'project manager', location:'Scotland', group:'Professional',
    titleIncludes:['project manager','programme manager','project lead','project director','delivery manager','project officer'] },
  { id:'scot-ba', label:'Business Analyst', tab:'SCOTLAND', source:'nhs',
    keyword:'business analyst', location:'Scotland', group:'Professional',
    titleIncludes:['business analyst','systems analyst','process analyst','transformation analyst'] },
  { id:'scot-coordinator', label:'Coordinator', tab:'SCOTLAND', source:'nhs',
    keyword:'pathway coordinator', location:'Scotland', group:'Professional',
    titleIncludes:['pathway coordinator','patient coordinator','care coordinator','referral coordinator','discharge coordinator','admissions coordinator','outpatient coordinator','appointments coordinator','waiting list coordinator','access coordinator'] },

  // ── CIVIL SERVICE CATEGORIES ──────────────────────────────────
  // Admin roles EO to SEO
  { id:'cs-eo-admin', label:'Admin Officer (EO)', tab:'CIVIL SERVICE', source:'civil',
    keyword:'administrative officer EO', group:'Admin',
    titleIncludes:['administrative officer','admin officer','executive officer','eo grade','personal secretary','team leader','office manager','correspondence officer','case officer','casework officer'],
    titleExcludes:['senior executive','heo','seo','grade 6','grade 7','senior manager'] },
  { id:'cs-heo-admin', label:'Higher Admin Officer (HEO)', tab:'CIVIL SERVICE', source:'civil',
    keyword:'higher executive officer HEO', group:'Admin',
    titleIncludes:['higher executive officer','heo','senior admin','senior officer','team manager','senior case officer','senior casework','policy officer','senior correspondence'],
    titleExcludes:['senior executive officer','seo','grade 6','grade 7'] },
  { id:'cs-seo-admin', label:'Senior Admin Officer (SEO)', tab:'CIVIL SERVICE', source:'civil',
    keyword:'senior executive officer SEO', group:'Admin',
    titleIncludes:['senior executive officer','seo','senior manager','senior policy','team leader seo','senior coordinator','senior operations'],
    titleExcludes:['grade 6','grade 7','deputy director'] },
  // Tech roles
  { id:'cs-software-dev', label:'Software Developer', tab:'CIVIL SERVICE', source:'civil',
    keyword:'software developer civil service', group:'Technology',
    titleIncludes:['software developer','software engineer','developer','engineer','full stack','backend','frontend','devops','cloud engineer','platform engineer','site reliability'] },
  { id:'cs-data-analyst', label:'Data Analyst', tab:'CIVIL SERVICE', source:'civil',
    keyword:'data analyst civil service', group:'Technology',
    titleIncludes:['data analyst','data analytics','data engineer','data scientist','business intelligence','bi analyst','power bi','tableau','reporting analyst','information analyst'] },
  { id:'cs-cyber', label:'Cyber Security', tab:'CIVIL SERVICE', source:'civil',
    keyword:'cyber security civil service', group:'Technology',
    titleIncludes:['cyber security','cybersecurity','information security','security analyst','security engineer','soc analyst','penetration tester','security architect'] },
  { id:'cs-it-support', label:'IT Support', tab:'CIVIL SERVICE', source:'civil',
    keyword:'IT support civil service', group:'Technology',
    titleIncludes:['it support','ict support','service desk','helpdesk','desktop support','1st line','2nd line','3rd line','infrastructure engineer','network engineer','systems administrator'] },
  { id:'cs-architecture', label:'IT Architecture', tab:'CIVIL SERVICE', source:'civil',
    keyword:'solutions architect civil service', group:'Technology',
    titleIncludes:['architect','solutions architect','enterprise architect','technical architect','cloud architect','network architect','security architect'] },
  { id:'cs-ddat', label:'Digital & Technology', tab:'CIVIL SERVICE', source:'civil',
    keyword:'digital technology DDAT civil service', group:'Technology',
    titleIncludes:['digital','technology','ddat','product manager','product owner','delivery manager','agile','scrum','technical','ux designer','user researcher','interaction designer','content designer'] },
  { id:'cs-project-manager', label:'Project Manager', tab:'CIVIL SERVICE', source:'civil',
    keyword:'project manager civil service', group:'Technology',
    titleIncludes:['project manager','programme manager','project lead','delivery manager','project officer','pmo','portfolio manager'] },
  { id:'cs-business-analyst', label:'Business Analyst', tab:'CIVIL SERVICE', source:'civil',
    keyword:'business analyst civil service', group:'Technology',
    titleIncludes:['business analyst','systems analyst','process analyst','transformation analyst','change analyst'] },
];

// ── FETCH AND FILTER ONE CATEGORY ─────────────────────────────
async function fetchCategory(cat) {
  const cacheKey = cat.id;
  const cached   = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.jobs;

  try {
    const seen = new Set();
    const all  = [];

    for (let p = 1; p <= 20; p++) {
      let pageJobs;
      if (cat.source === 'civil') {
        pageJobs = await fetchCivilService(cat.keyword, p);
      } else {
        pageJobs = await fetchNhsSearch(cat.keyword, cat.location, p);
      }
      if (!pageJobs.length) break;
      let added = 0;
      for (const j of pageJobs) {
        if (seen.has(j.id)) continue;
        seen.add(j.id); all.push(j); added++;
      }
      if (!added) break;
    }

    const filtered = applyFilters(all, {
      minBand: cat.minBand, maxBand: cat.maxBand,
      excludeLocation: cat.excludeLocation,
      titleIncludes: cat.titleIncludes,
      titleExcludes: cat.titleExcludes,
      source: cat.source,
    });

    CACHE.set(cacheKey, { at: Date.now(), jobs: filtered });
    return filtered;
  } catch(err) {
    const stale = CACHE.get(cacheKey);
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
  const pg      = parseInt(page);
  const perPage = 20;

  // Filter categories by tab and optionally by category
  let targets = CATEGORIES.filter(c => c.tab === tab);
  if (category && category !== 'All') {
    targets = targets.filter(c => c.label === category || c.id === category);
    if (!targets.length) return res.status(404).json({ error:'Unknown category' });
  }

  const allResults = [];
  await Promise.all(targets.map(async cat => {
    const jobs = await fetchCategory(cat);
    jobs.forEach(j => allResults.push({...j, category: cat.label, group: cat.group}));
  }));

  allResults.sort((a,b) => {
    if (!a.postedDate && !b.postedDate) return 0;
    if (!a.postedDate) return 1;
    if (!b.postedDate) return -1;
    return new Date(b.postedDate) - new Date(a.postedDate);
  });

  const total = allResults.length;
  const start = (pg-1)*perPage;
  const jobs  = allResults.slice(start, start+perPage);

  res.status(200).json({
    fetchedAt: new Date().toISOString(),
    total, page: pg,
    pages: Math.ceil(total/perPage),
    jobs,
  });
}
