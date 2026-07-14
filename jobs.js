// Vercel serverless function - exact port of Lovable's jobs.ts
// Deploy to Vercel - runs on Node.js edge, no WordPress needed

const CACHE = new Map();
const TTL_MS = 30 * 60 * 1000; // 30 min cache

function decodeEntities(s) {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&nbsp;/g,' ');
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

function parseSearchHtml(html) {
  const jobs = [];
  const liRe = /<li[^>]*class="[^"]*\bsearch-result\b[^"]*"[^>]*>([\s\S]*?)(?=<li[^>]*class="[^"]*\bsearch-result\b|<\/ul)/g;
  let match;
  while ((match = liRe.exec(html)) !== null) {
    const block = match[1];
    const titleMatch = block.match(/<a[^>]*href="(\/candidate\/jobadvert\/[^"]+)"[^>]*data-test="search-result-job-title"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const href  = decodeEntities(titleMatch[1]);
    const title = stripTags(titleMatch[2]);
    const url   = `https://www.jobs.nhs.uk${href}`;

    let organisation = 'NHS', location = 'United Kingdom';
    const locBlock = block.match(/<div[^>]*data-test="search-result-location"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="nhsuk-grid-row/i);
    if (locBlock) {
      const inner  = locBlock[1];
      const orgM   = inner.match(/<h3[^>]*>([\s\S]*?)<div[^>]*class="location-font-size"/i);
      if (orgM) organisation = stripTags(orgM[1]);
      const locM   = inner.match(/<div[^>]*class="location-font-size"[^>]*>([\s\S]*?)<\/div>/i);
      if (locM) location = stripTags(locM[1]).replace(/,\s*$/,'');
    }

    const salary        = pickAfterLabel(block,'search-result-salary');
    const postedDate    = pickAfterLabel(block,'search-result-publicationDate');
    const closingDate   = pickAfterLabel(block,'search-result-closingDate');
    const contractType  = pickAfterLabel(block,'search-result-jobType');
    const workingPattern= pickAfterLabel(block,'search-result-workingPattern');
    const band          = extractBand(`${title} ${salary}`);
    const refMatch      = href.match(/\/jobadvert\/([^?]+)/);
    const id            = refMatch ? refMatch[1] : `${jobs.length}-${title.slice(0,20)}`;

    jobs.push({ id, title, organisation, location, salary: salary||undefined,
      band, postedDate: postedDate||undefined, closingDate: closingDate||undefined,
      contractType: contractType||undefined, workingPattern: workingPattern||undefined, url });
  }
  return jobs;
}

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
  if (!res.ok) throw new Error(`NHS Jobs returned ${res.status}`);
  return parseSearchHtml(await res.text());
}

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
    const org = j.organisation.toLowerCase();
    if (!/\bnhs\s*(foundation\s*)?trust\b/.test(org) &&
        !org.includes('nhs') && !org.includes('health board') &&
        !org.includes('hospital') && !org.includes('integrated care') &&
        !org.includes('ips employment')) return false;
    const hay = `${j.title} ${j.contractType??''} ${j.workingPattern??''}`.toLowerCase();
    if (/\b(bank|fixed[\-\s]?term|locum|secondment|temporary|agency)\b/.test(hay)) return false;
    if (j.contractType && !j.contractType.toLowerCase().includes('permanent')) return false;
    return true;
  });
}

const CLINICAL_EXCLUDES = ['nurse','nursing','doctor','consultant','registrar','physician','surgeon','midwife','practitioner','therapist','pharmacist','radiographer','psychologist','paramedic','sonographer','clinical'];

const CATEGORIES = [
  { id:'admin-outside-london',   label:'Admin Outside London',            keyword:'administrator',              excludeLocation:'London',        minBand:4, group:'Admin',          titleIncludes:['admin','administrator','administrative','secretary','clerk','receptionist','coordinator','officer','assistant'], titleExcludes:CLINICAL_EXCLUDES },
  { id:'admin-london',           label:'Admin in London',                 keyword:'administrator',              location:'London',               minBand:4, group:'Admin',          titleIncludes:['admin','administrator','administrative','secretary','clerk','receptionist','coordinator','officer','assistant'], titleExcludes:CLINICAL_EXCLUDES },
  { id:'sw-london',              label:'Support Worker in London',        keyword:'support worker',             location:'London',               minBand:3, group:'Support Worker',  titleIncludes:['support worker','healthcare support','health care support','care support','healthcare assistant','hca','hcsw'] },
  { id:'sw-outside-london',      label:'Support Worker Outside London',   keyword:'support worker',             excludeLocation:'London',        minBand:3, group:'Support Worker',  titleIncludes:['support worker','healthcare support','health care support','care support','healthcare assistant','hca','hcsw'] },
  { id:'sw-west-midlands',       label:'Support Worker West Midlands',    keyword:'support worker',             location:'West Midlands',        minBand:3, group:'Support Worker',  titleIncludes:['support worker','healthcare support','care support','healthcare assistant','hca'] },
  { id:'sw-wales',               label:'Support Worker in Wales',         keyword:'support worker',             location:'Wales',                minBand:3, group:'Support Worker',  titleIncludes:['support worker','healthcare support','care support','healthcare assistant','hca'] },
  { id:'sw-manchester',          label:'Support Worker Manchester',       keyword:'support worker',             location:'Manchester',           minBand:3, group:'Support Worker',  titleIncludes:['support worker','healthcare support','care support','healthcare assistant','hca'] },
  { id:'sw-west-yorkshire',      label:'Support Worker West Yorkshire',   keyword:'support worker',             location:'West Yorkshire',       minBand:3, group:'Support Worker',  titleIncludes:['support worker','healthcare support','care support','healthcare assistant','hca'] },
  { id:'sw-east-yorkshire',      label:'Support Worker East Yorkshire',   keyword:'support worker',             location:'East Yorkshire',       minBand:3, group:'Support Worker',  titleIncludes:['support worker','healthcare support','care support','healthcare assistant','hca'] },
  { id:'clinical-fellow',        label:'Clinical Fellow',                 keyword:'clinical fellow',            group:'Clinical',                titleIncludes:['clinical fellow','fellow','fy1','fy2','fy3','st1','st2','st3','st4','ct1','ct2','trust doctor','specialty doctor','specialty registrar','foundation year','junior clinical','sas doctor','associate specialist'] },
  { id:'data-analyst',           label:'Data Analyst',                    keyword:'data analyst',               group:'Professional',            titleIncludes:['data analyst','data analytics','information analyst','reporting analyst','data engineer','data scientist'] },
  { id:'bi-analyst',             label:'BI Analyst',                      keyword:'business intelligence analyst', group:'Professional',         titleIncludes:['business intelligence','bi analyst','bi developer','bi lead','power bi','tableau'] },
  { id:'financial-analyst',      label:'Financial Analyst',               keyword:'financial analyst',           group:'Professional',            titleIncludes:['financial analyst','finance analyst','financial planning','fp&a','financial reporting'] },
  { id:'desk-analyst',           label:'Desk Analyst',                    keyword:'service desk analyst',        group:'Professional',            titleIncludes:['desk analyst','service desk','helpdesk','1st line','2nd line','3rd line','it support analyst'] },
  { id:'dietician',              label:'Dietician',                       keyword:'dietitian',                   group:'Clinical',                titleIncludes:['dietitian','dietician'] },
  { id:'finance',                label:'Finance',                         keyword:'finance officer',             group:'Professional',            titleIncludes:['finance officer','finance manager','finance assistant','finance director','management accountant','financial accountant','payroll'] },
  { id:'hr',                     label:'HR',                              keyword:'human resources',             group:'Professional',            titleIncludes:['hr advisor','hr officer','hr assistant','hr manager','hr business partner','human resources','people advisor','people partner','workforce','resourcing'] },
  { id:'it-engineering',         label:'IT / Engineering',                keyword:'IT engineer',                 group:'Professional',            titleIncludes:['it engineer','network engineer','software developer','software engineer','infrastructure engineer','cyber security','cloud engineer','devops','solutions architect','technical architect'], titleExcludes:['clinical','biomedical'] },
  { id:'project-manager',        label:'Project Manager',                 keyword:'project manager',             group:'Professional',            titleIncludes:['project manager','programme manager','project lead','project director','delivery manager','project officer'] },
  { id:'business-analyst',       label:'Business Analyst',                keyword:'business analyst',            group:'Professional',            titleIncludes:['business analyst','systems analyst','process analyst','transformation analyst'] },
  { id:'social-worker',          label:'Social Worker',                   keyword:'social worker',               group:'Clinical',                titleIncludes:['social worker','amhp','approved mental health professional'] },
  { id:'logistics',              label:'Logistics',                       keyword:'logistics',                   group:'Professional',            titleIncludes:['logistics','supply chain','procurement','stores officer','transport manager','fleet manager','inventory'] },
  { id:'coordinator',            label:'Coordinator',                     keyword:'pathway coordinator',         group:'Professional',            titleIncludes:['pathway coordinator','patient coordinator','care coordinator','referral coordinator','discharge coordinator','admissions coordinator','outpatient coordinator','appointments coordinator','waiting list coordinator','access coordinator'] },
  { id:'microbiology',           label:'Microbiology',                    keyword:'microbiology',                group:'Clinical',                titleIncludes:['microbiology','microbiologist','biomedical scientist microbiology'] },
  { id:'phlebotomist',           label:'Phlebotomist Leader',             keyword:'phlebotomist',                group:'Clinical',                titleIncludes:['phlebotomist','phlebotomy'] },
  { id:'research-assistant',     label:'Research Assistant',              keyword:'research assistant',          group:'Clinical',                titleIncludes:['research assistant','research associate','research practitioner','research nurse','research officer','clinical research','trial coordinator','study coordinator'] },
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { category } = req.query;
  const targets = category && category !== 'All'
    ? CATEGORIES.filter(c => c.label === category || c.id === category)
    : CATEGORIES;

  const results = {};

  await Promise.all(targets.map(async cat => {
    const cacheKey = cat.id;
    const cached   = CACHE.get(cacheKey);
    if (cached && Date.now() - cached.at < TTL_MS) {
      results[cat.label] = { jobs: cached.jobs, total: cached.jobs.length };
      return;
    }
    try {
      const seen = new Set();
      const all  = [];
      for (let page = 1; page <= 20; page++) {
        const pageJobs = await fetchNhsSearch(cat.keyword, cat.location, page);
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
      });
      CACHE.set(cacheKey, { at: Date.now(), jobs: filtered });
      results[cat.label] = { jobs: filtered, total: filtered.length };
    } catch(err) {
      results[cat.label] = { jobs: [], total: 0, error: err.message };
    }
  }));

  const allJobs = Object.entries(results).flatMap(([cat, data]) =>
    data.jobs.map(j => ({ ...j, category: cat }))
  );

  res.status(200).json({
    fetchedAt: new Date().toISOString(),
    total: allJobs.length,
    jobs: allJobs,
    categories: results,
  });
}
