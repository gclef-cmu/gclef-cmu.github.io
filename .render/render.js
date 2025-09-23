const fs = require("fs").promises;
const path = require("path");
const { marked } = require("marked");
const DOMPurify = require("dompurify");
const { JSDOM } = require("jsdom");
const yaml = require("js-yaml");
const crypto = require("crypto");

const REPO_ROOT = process.cwd();
const RENDER_ROOT = path.join(REPO_ROOT, ".render");
const OUTPUT_ROOT = path.join(REPO_ROOT, "_site");

// ================================
// Markdown renderer configuration
// ================================
marked.setOptions({
    headerIds: true,
    mangle: false,
    gfm: true,
    breaks: true,
    tables: true,
    highlight: function (code, lang) {
        return `<pre class="language-${lang}"><code class="language-${lang}">${escapeHtml(
            code
        )}</code></pre>`;
    },
});

// ================================
// Helpers (no side effects)
// ================================
/* Escape special HTML characters in a string. */
function escapeHtml(text) {
    const map = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
}

// Add id attributes to headings (simple deterministic slug)
function addHeadingIds(htmlContent) {
    const dom = new JSDOM(`<!DOCTYPE html><body>${htmlContent}</body>`);
    const document = dom.window.document;
    const used = new Set();
    function slugify(text) {
        return String(text || "")
            .toLowerCase()
            .replace(/<[^>]*>/g, "")
            .trim()
            .replace(/[^\w\s-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-");
    }
    document.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
        const base = slugify(h.textContent);
        let id = base;
        let i = 1;
        while (id && used.has(id)) id = `${base}-${i++}`;
        if (id) {
            h.setAttribute("id", id);
            used.add(id);
        }
    });
    return document.body.innerHTML;
}

/* Recursively walk files under startDir (excluding hidden/system dirs) and invoke onFile for each file. */
async function walkFiles(startDir, onFile) {
    const excludeNames = new Set([
        ".git",
        ".github",
        ".render",
        "_site",
        "node_modules",
    ]);
    async function walk(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith(".")) continue;
            if (excludeNames.has(entry.name)) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
            } else if (entry.isFile()) {
                await onFile(fullPath);
            }
        }
    }
    await walk(startDir);
}

/* Collect absolute paths of .md files under startDir. */
async function findMarkdownFiles(startDir) {
    const results = [];
    await walkFiles(startDir, async (fullPath) => {
        if (/\.md$/i.test(fullPath)) results.push(fullPath);
    });
    return results;
}

/* Copy entire tree from startDir to outputDir, preserving structure. */
async function copyTree(startDir, outputDir) {
    await walkFiles(startDir, async (fullPath) => {
        const rel = path.relative(startDir, fullPath);
        const dest = path.join(outputDir, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(fullPath, dest);
    });
}

/* Parse leading YAML frontmatter from markdown; returns {attributes, body}. */
function parseYamlFrontmatter(md) {
    const m = String(md).match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
    if (!m) return { attributes: {}, body: String(md) };
    let attributes = {};
    try {
        attributes = yaml.load(m[1]) || {};
    } catch {
        attributes = {};
    }
    const body = String(md).slice(m[0].length);
    return { attributes, body };
}

/* Extract the first H1 heading text from markdown or throw if none. */
function parseFirstH1(md) {
    const m = String(md).match(/^\s{0,3}#\s+(.+)$/m);
    if (!m) throw new Error("No H1 header found");
    return m[1].trim();
}

// ================================
// Simplified path handling
// ================================
/*
Map a source .md path to its output HTML file path. Examples:

- HOME.md -> _site/index.html (home page)
- foo.md -> _site/foo/index.html
- foo/index.md -> _site/foo/index.html
- foo/bar.md -> _site/foo/bar/index.html
- foo/bar/index.md -> _site/foo/bar/index.html
*/
function computeOutputHtmlPath(mdPath, homeMdBasename) {
    const rel = path.relative(REPO_ROOT, mdPath);
    const base = path.basename(rel);
    const dir = path.dirname(rel);

    // Home page special cases
    // - Configured home page
    // - Conventional root HOME.md
    if (dir === "." && (base === homeMdBasename || base === "HOME.md")) {
        return path.join(OUTPUT_ROOT, "index.html");
    }

    // 404 page special case at repo root
    if (dir === "." && base === "404.md") {
        return path.join(OUTPUT_ROOT, "404.html");
    }

    // Index.md special case
    if (base === "index.md") {
        return path.join(OUTPUT_ROOT, dir, "index.html");
    }

    // Everything else becomes dir/name/index.html
    const name = base.replace(/\.md$/i, "");
    return path.join(
        OUTPUT_ROOT,
        dir === "." ? name : path.join(dir, name),
        "index.html"
    );
}

/*
Rewrite links/resources in rendered HTML (KISS):
- Leave hrefs and their anchors as-authored (no slug normalization, no .md rewriting)
- Rebase asset src paths relative to the output page directory
- Skip external links and mailto/tel
*/
function rebaseAssetSrcPaths(htmlContent, sourceMdPath, currentOutPath) {
    const dom = new JSDOM(`<!DOCTYPE html><body>${htmlContent}</body>`);
    const document = dom.window.document;
    const sourceDir = path.dirname(sourceMdPath);
    const currentDir = path.dirname(currentOutPath);

    document
        .querySelectorAll(
            "a[href], img[src], video[src], audio[src], source[src], link[href], script[src]"
        )
        .forEach((el) => {
            const isHref = el.hasAttribute("href");
            const attr = isHref ? "href" : "src";
            const raw = el.getAttribute(attr);
            if (typeof raw !== "string" || raw.length === 0) return;

            // Skip external links
            if (/^(https?:)?\/\//i.test(raw)) return;
            if (/^(mailto:|tel:)/i.test(raw)) return;

            // Keep pure anchors as-authored
            if (raw.startsWith("#")) return;

            // Split into [path+query] and [hash]
            const hashIndex = raw.indexOf("#");
            const baseAndQuery = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
            const anchorPart = hashIndex >= 0 ? raw.slice(hashIndex + 1) : "";

            // Further split base into [path] and [query]
            const qIndex = baseAndQuery.indexOf("?");
            let pathPart =
                qIndex >= 0 ? baseAndQuery.slice(0, qIndex) : baseAndQuery;
            const queryPart = qIndex >= 0 ? baseAndQuery.slice(qIndex) : "";

            // Adjust paths
            if (!isHref) {
                // For assets: rebase relative to output location
                // Resolve asset absolute path based on source markdown file location
                const assetAbs = path.resolve(sourceDir, decodeURI(pathPart));
                const assetRelFromRepo = path.relative(REPO_ROOT, assetAbs);
                const assetOutPath = path.join(OUTPUT_ROOT, assetRelFromRepo);
                // Compute path from current output dir to the asset's output path
                pathPart = path
                    .relative(currentDir, assetOutPath)
                    .split(path.sep)
                    .join("/");
            }

            // Reconstruct without modifying the anchor
            const hash = anchorPart ? "#" + anchorPart : "";
            let newValue = pathPart + queryPart + hash;
            if (newValue === "" && isHref) newValue = ".";

            el.setAttribute(attr, newValue);
        });

    return document.body.innerHTML;
}

/* Add padding to paragraphs that come before H2 headers */
function addPaddingBeforeH2(htmlContent) {
    const dom = new JSDOM(`<!DOCTYPE html><body>${htmlContent}</body>`);
    const document = dom.window.document;
    
    const h2Elements = document.querySelectorAll('h2');
    h2Elements.forEach(h2 => {
        const previousElement = h2.previousElementSibling;
        if (previousElement && previousElement.tagName === 'P') {
            previousElement.style.paddingBottom = '70px';
        }
    });
    
    return document.body.innerHTML;
}

/* Copy template stylesheet to versioned asset path (content-hash) and return its destination path. */
async function copyStylesheet() {
    const src = path.join(RENDER_ROOT, "template", "style.css");
    const outDir = path.join(OUTPUT_ROOT, "assets");
    await fs.mkdir(outDir, { recursive: true });

    const css = await fs.readFile(src);
    const hash = crypto
        .createHash("sha1")
        .update(css)
        .digest("hex")
        .slice(0, 8);
    const dest = path.join(outDir, `style.${hash}.css`);
    await fs.writeFile(dest, css);
    return dest;
}

/* Load members data from JSON file */
async function loadMembersData() {
    const membersPath = path.join(REPO_ROOT, "team", "members.json");
    try {
        const raw = await fs.readFile(membersPath, "utf-8");
        return JSON.parse(raw);
    } catch (error) {
        console.warn(`Warning: Could not load members data from ${membersPath}:`, error.message);
        return { faculty: [], students: [] };
    }
}

/* Load BibTeX data from .bib file */
async function findImageFile(publicationId) {
    const previewsDir = path.join(REPO_ROOT, "static", "previews");
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
    
    try {
        const files = await fs.readdir(previewsDir);
        
        // Look for files that start with the publication ID
        for (const file of files) {
            const fileName = path.parse(file).name;
            const extension = path.parse(file).ext.toLowerCase();
            
            if (fileName === publicationId && imageExtensions.includes(extension)) {
                return file; // Return the full filename with extension
            }
        }
        
        // Fallback to .png if no image found
        return `${publicationId}.png`;
    } catch (error) {
        console.warn(`Warning: Could not read previews directory:`, error.message);
        return `${publicationId}.png`;
    }
}

async function loadBibtexData() {
    const bibtexPath = path.join(REPO_ROOT, "research", "bibtex.bib");
    try {
        const raw = await fs.readFile(bibtexPath, "utf-8");
        
        // Parse BibTeX entries
        const bibtexData = {};
        const entries = raw.split(/\n(?=@)/);
        
        entries.forEach(entry => {
            if (entry.trim()) {
                // Extract the key (first line after @type{key,)
                const keyMatch = entry.match(/@\w+\{([^,]+),/);
                if (keyMatch) {
                    const key = keyMatch[1].trim();
                    bibtexData[key] = entry.trim();
                }
            }
        });
        
        return bibtexData;
    } catch (error) {
        console.warn(`Warning: Could not load BibTeX data from ${bibtexPath}:`, error.message);
        return {};
    }
}

/* Load research data from JSON file */
async function loadResearchData() {
    const researchPath = path.join(REPO_ROOT, "research", "research.json");
    try {
        const raw = await fs.readFile(researchPath, "utf-8");
        return JSON.parse(raw);
    } catch (error) {
        console.warn(`Warning: Could not load research data from ${researchPath}:`, error.message);
        return { publications: [] };
    }
}

/* Generate faculty content HTML from members data */
function generateFacultyContent(membersData) {
    let html = "";
    
    if (membersData.faculty && membersData.faculty.length > 0) {
        membersData.faculty.forEach(member => {
            html += `<div class="faculty-member">\n`;
            html += `  <div class="faculty-photo">\n`;
            html += `    <a href="${member.website}"><img src="../static/headshots/${member.photo}" alt="${member.name}" class="team-headshot"></a>\n`;
            html += `  </div>\n`;
            html += `  <div class="faculty-info">\n`;
            html += `    <h2 class="team-name"><a href="${member.website}">${member.name}</a></h2>\n`;
            html += `    <div class="faculty-bio">\n`;
            html += `      <p>${member.bio}</p>\n`;
            html += `      <p class="team-email"><a href="mailto:${member.email}">${member.email}</a></p>\n`;
            html += `    </div>\n`;
            html += `  </div>\n`;
            html += `</div>\n\n`;
        });
    }
    
    return html;
}

/* Generate students content HTML from members data */
function generateStudentsContent(membersData) {
    let html = `<div class="students-grid">\n`;
    
    if (membersData.students && membersData.students.length > 0) {
        membersData.students.forEach(member => {
            html += `  <div class="student-card">\n`;
            html += `    <div class="student-photo">\n`;
            html += `      <a href="${member.website}"><img src="../static/headshots/${member.photo}" alt="${member.name}" class="team-headshot"></a>\n`;
            html += `    </div>\n`;
            html += `    <div class="student-info">\n`;
            html += `      <h3 class="team-name"><a href="${member.website}">${member.name}</a></h3>\n`;
            html += `      <p class="student-type">${member.type}</p>\n`;
            html += `      <p class="student-dept">${member.department}</p>\n`;
            html += `      <p class="team-email"><a href="mailto:${member.email}">${member.email}</a></p>\n`;
            html += `    </div>\n`;
            html += `  </div>\n`;
        });
    }
    
    html += `</div>\n`;
    
    return html;
}

/* Generate research content HTML from research data */
async function generateResearchContent(researchData, bibtexData) {
    let html = "";
    
    if (researchData.publications && researchData.publications.length > 0) {
        // Group publications by year
        const publicationsByYear = {};
        researchData.publications.forEach(pub => {
            if (!publicationsByYear[pub.year]) {
                publicationsByYear[pub.year] = [];
            }
            publicationsByYear[pub.year].push(pub);
        });
        
        // Sort years in descending order
        const sortedYears = Object.keys(publicationsByYear).sort((a, b) => b - a);
        
        // Generate HTML for each year
        for (const year of sortedYears) {
            html += `<h2 class="year-heading">${year}</h2>\n`;
            
            for (const pub of publicationsByYear[year]) {
                const imageFile = await findImageFile(pub.id);
                
                html += `<div class="publication">\n`;
                
                // Add preview image if available
                html += `  <div class="publication-preview">\n`;
                html += `    <a href="../research/${pub.id}/">\n`;
                html += `      <img src="../static/previews/${pub.id}.png" alt="${pub.title}" class="preview-image">\n`;
                html += `    </a>\n`;
                html += `  </div>\n`;
                
                html += `  <div class="publication-content">\n`;
                html += `    <h3 class="publication-title"><a href="../research/${pub.id}/">${pub.title}</a></h3>\n`;
                html += `    <div class="publication-authors">${pub.authors}</div>\n`;
                html += `    <div class="publication-venue-year">${pub.venue} ${pub.year}</div>\n`;
                html += `    <div class="publication-links">\n`;
                
                html += `      <a href="../static/pdfs/${pub.id}.pdf" class="publication-link" target="_blank"><i class="fa-solid fa-file"></i> Paper</a>\n`;
                
                if (pub.project_link) {
                    html += `      <a href="${pub.project_link}" class="publication-link"><i class="fa-solid fa-house"></i> Website</a>\n`;
                }
                if (pub.blog_link) {
                    html += `      <a href="${pub.blog_link}" class="publication-link"><i class="fa-solid fa-feather"></i> Blog</a>\n`;
                }
                if (pub.video_link) {
                    html += `      <a href="${pub.video_link}" class="publication-link"><i class="fa-solid fa-video"></i> Video</a>\n`;
                }
                if (pub.code_link) {
                    html += `      <a href="${pub.code_link}" class="publication-link"><i class="fa-solid fa-code"></i> Code</a>\n`;
                }
                
                html += `    </div>\n`;
                
                if (pub.award) {
                    html += `    <div class="publication-award">\n`;
                    html += `      <i class="fas fa-trophy"></i> ${pub.award}\n`;
                    html += `    </div>\n`;
                }
                
                html += `  </div>\n`;
                html += `</div>\n\n`;
            }
        }
    }
    
    return html;
}

/* Generate individual project page HTML */
async function generateProjectPageHtml(publication, bibtexData) {
    const imageFile = await findImageFile(publication.id);
    
    let html = `<h1 class="project-title">${publication.title}</h1>\n\n`;
    
    html += `<div class="project-authors">${publication.authors}</div>\n\n`;
    
    html += `<div class="project-venue">${publication.venue} ${publication.year}</div>\n\n`;
    
    html += `<div class="project-links">\n`;
    html += `  <a href="../../static/pdfs/${publication.id}.pdf" class="project-link" target="_blank"><i class="fa-solid fa-file"></i> Paper</a>\n`;
    
    if (publication.project_link) {
        html += `  <a href="${publication.project_link}" class="project-link"><i class="fa-solid fa-house"></i> Website</a>\n`;
    }
    if (publication.blog_link) {
        html += `  <a href="${publication.blog_link}" class="project-link"><i class="fa-solid fa-feather"></i> Blog</a>\n`;
    }
    if (publication.video_link) {
        html += `  <a href="${publication.video_link}" class="project-link"><i class="fa-solid fa-video"></i> Video</a>\n`;
    }
    if (publication.code_link) {
        html += `  <a href="${publication.code_link}" class="project-link"><i class="fa-solid fa-code"></i> Code</a>\n`;
    }
    
    html += `</div>\n\n`;
    
    if (publication.award) {
        html += `<div class="project-award">\n`;
        html += `  <i class="fas fa-trophy"></i> ${publication.award}\n`;
        html += `</div>\n\n`;
    }
    
    html += `<hr class="project-divider">\n\n`;
    
    html += `<div class="project-preview">\n`;
    html += `  <img src="../../static/previews/${imageFile}" alt="${publication.title}" class="project-image">\n`;
    html += `</div>\n\n`;
    
    html += `## Abstract\n\n`;
    html += `<p>${publication.abstract}</p>\n\n`;
    
    if (bibtexData[publication.id]) {
        html += `## Citation\n\n`;
        html += `<div class="citation-content">\n`;
        html += `  <pre><code>${bibtexData[publication.id]}</code></pre>\n`;
        html += `</div>\n\n`;
    }
    
    return html;
}

/* Clean up project directories not in the JSON list */
async function cleanupProjectDirectories(researchData) {
    const researchDir = path.join(REPO_ROOT, "research");
    
    try {
        const entries = await fs.readdir(researchDir, { withFileTypes: true });
        
        // Get list of valid IDs from JSON
        const validIds = new Set();
        if (researchData.publications && researchData.publications.length > 0) {
            researchData.publications.forEach(pub => {
                if (pub.id) {
                    validIds.add(pub.id);
                }
            });
        }
        
        // Check each directory
        for (const entry of entries) {
            if (entry.isDirectory() && entry.name !== 'pdfs' && entry.name !== 'previews') {
                // This is a project directory
                if (!validIds.has(entry.name)) {
                    console.log(`🗑️  Removing orphaned project directory: ${entry.name}`);
                    const dirPath = path.join(researchDir, entry.name);
                    await fs.rm(dirPath, { recursive: true, force: true });
                }
            }
        }
    } catch (error) {
        console.warn(`Warning: Could not clean up project directories:`, error.message);
    }
}

function generatePageHtml(templateContent, pageType, data, bibtexData) {
    if (pageType === 'team') {
        const facultyContent = generateFacultyContent(data);
        const studentsContent = generateStudentsContent(data);
        
        return templateContent
            .replace('{{FACULTY_CONTENT}}', facultyContent)
            .replace('{{STUDENTS_CONTENT}}', studentsContent);
    } else if (pageType === 'research') {
        // This will be handled asynchronously in renderPage
        return templateContent;
    }
    
    return templateContent;
}

// Generate research highlights for home page
async function generateResearchHighlights(researchData) {
    if (!researchData.publications || researchData.publications.length === 0) {
        return '';
    }
    
    // Get the 9 most recent publications (or all if less than 9)
    const recentPublications = researchData.publications
        .sort((a, b) => b.year - a.year) // Sort by year descending
        .slice(0, 9);
    
    let html = '<div class="research-highlights">\n';
    
    for (const pub of recentPublications) {
        html += `  <div class="research-card">\n`;
        html += `    <a href="./research/${pub.id}/" class="research-card-link">\n`;
        html += `      <div class="research-card-image">\n`;
        html += `        <img src="./static/previews/${pub.id}.png" alt="${pub.title}" class="preview-image">\n`;
        html += `      </div>\n`;
        html += `      <div class="research-card-content">\n`;
        html += `        <h3 class="research-card-title">${pub.nickname}</h3>\n`;
        html += `        <div class="research-card-meta">\n`;
        html += `          <span class="research-card-venue">${pub.venue} ${pub.year}</span>\n`;
        if (pub.award) {
            html += `          <span class="research-card-award">${pub.award}</span>\n`;
        }
        html += `        </div>\n`;
        html += `      </div>\n`;
        html += `    </a>\n`;
        html += `  </div>\n`;
    }
    
    html += '</div>\n';
    return html;
}

// ================================
// Simplified nav handling
// ================================
/*
Build nav items strictly from config.nav using { Title: "href" } mapping:
- href: external URL (http/https, mailto, tel) or .md file path
- title: used as-is
*/
async function buildNavItems(config, homeMdBasename) {
    const results = [];
    for (const item of config.nav) {
        if (!item || typeof item !== "object") {
            throw new Error(
                'config.nav items must be objects like { Title: "href" }'
            );
        }

        const title = Object.keys(item)[0];
        const href = item[title];

        if (typeof title !== "string" || !title.trim()) {
            throw new Error("config.nav item is missing a non-empty title key");
        }
        if (typeof href !== "string" || !href.trim()) {
            throw new Error(
                `config.nav item '${title}' is missing a non-empty href value`
            );
        }

        // External links
        if (/^(https?:)?\/\//i.test(href) || /^(mailto:|tel:)/i.test(href)) {
            results.push({ type: "external", href, title });
            continue;
        }

        // Internal markdown files only
        if (/\.md$/i.test(href)) {
            const mdPath = path.join(REPO_ROOT, href);
            results.push({
                type: "internal",
                mdPath,
                title,
                outPath: computeOutputHtmlPath(mdPath, homeMdBasename),
            });
            continue;
        }

        throw new Error(
            `config.nav item '${title}' has unsupported href '${href}'. Use a .md file path or an external URL.`
        );
    }

    return results;
}

/* Render the site navigation HTML using the nav template. */
function buildNavHtml(
    navItems,
    currentOutPath,
    siteTitle,
    homeOutPath,
    navTemplate
) {
    const currentDir = path.dirname(currentOutPath);
    const homeHref =
        path
            .relative(currentDir, homeOutPath)
            .split(path.sep)
            .join("/")
            .replace(/(?:^|\/)index\.html$/, "") || ".";

    const links = navItems.map((item) => {
        if (item.type === "external") {
            return `<a href="${escapeHtml(
                item.href
            )}" target="_blank" rel="noopener noreferrer">${escapeHtml(
                item.title
            )}</a>`;
        }

        let href =
            path
                .relative(currentDir, item.outPath)
                .split(path.sep)
                .join("/")
                .replace(/(?:^|\/)index\.html$/, "") || ".";

        // Check if this nav item matches the current page
        // Normalize paths to handle different separators and resolve relative paths
        const normalizedCurrentPath = path.resolve(currentOutPath).replace(/\\/g, '/');
        const normalizedItemPath = path.resolve(item.outPath).replace(/\\/g, '/');
        const isCurrentPage = normalizedCurrentPath === normalizedItemPath;
        const currentPageClass = isCurrentPage ? " current-page" : "";

        return `<a href="${href}" class="${currentPageClass.trim()}">${escapeHtml(item.title)}</a>`;
    });

    // Compute relative path to the logo asset from the current page
    const logoOutPath = path.join(OUTPUT_ROOT, "static", "logos", "gclef.png");
    const logoSrc =
        path
            .relative(currentDir, logoOutPath)
            .split(path.sep)
            .join("/");

    const titleHtml = `<a href="${homeHref}" class="site-title"><img src="${logoSrc}" alt="Logo" class="site-logo">${escapeHtml(
        siteTitle
    )}</a>`;

    return navTemplate
        .replace("{{TITLE_HTML}}", titleHtml)
        .replace("{{LINKS_HTML}}", links.join(" "));
}

// ================================
// Main rendering
// ================================
/* Load and validate .render/config.yml; fills defaults and ensures required keys. */
async function loadConfig() {
    const configPath = path.join(REPO_ROOT, ".render", "config.yml");
    const raw = await fs.readFile(configPath, "utf-8");
    const cfg = yaml.load(raw) || {};

    if (!cfg.site_title) throw new Error("Missing site_title in config");
    if (!cfg.home_md) throw new Error("Missing home_md in config");
    if (!Array.isArray(cfg.nav)) cfg.nav = [];

    return cfg;
}

/*
Render a single markdown file to an HTML page:
- Parses frontmatter and title
- Converts markdown to sanitized HTML
- Rewrites links and injects nav/stylesheet into the template
- Writes the final HTML to the computed output path
*/
async function renderPage(mdPath, ctx) {
    const { template, purify, navItems, stylesheet, config, navTemplate, footerTemplate, membersData, researchData, bibtexData } = ctx;
    const homeMdBasename = path.basename(config.home_md);

    // Special handling for team and research pages - generate content from JSON data
    let raw, frontmatter, body;
    if (mdPath.endsWith('team/index.md')) {
        // Read the template file and generate content from members data
        const templateContent = await fs.readFile(mdPath, "utf-8");
        const generatedContent = generatePageHtml(templateContent, 'team', membersData, bibtexData);
        raw = generatedContent;
        const parsed = parseYamlFrontmatter(raw);
        frontmatter = parsed.attributes;
        body = parsed.body;
    } else if (mdPath.endsWith('research/index.md')) {
        // Read the template file and generate content from research data
        const templateContent = await fs.readFile(mdPath, "utf-8");
        const researchContent = await generateResearchContent(researchData, bibtexData);
        raw = templateContent.replace('{{RESEARCH_CONTENT}}', researchContent);
        const parsed = parseYamlFrontmatter(raw);
        frontmatter = parsed.attributes;
        body = parsed.body;
    } else if (mdPath.endsWith('HOME.md')) {
        // Handle home page with research highlights
        raw = await fs.readFile(mdPath, "utf-8");
        const parsed = parseYamlFrontmatter(raw);
        frontmatter = parsed.attributes;
        body = parsed.body;
        
        // Generate research highlights and replace placeholder
        const researchHighlights = await generateResearchHighlights(researchData);
        body = body.replace('{{RESEARCH_HIGHLIGHTS}}', researchHighlights);
    } else if (mdPath.includes('/research/') && mdPath.endsWith('/index.md')) {
        // Handle individual project pages
        const projectId = path.basename(path.dirname(mdPath));
        const publication = researchData.publications.find(pub => pub.id === projectId);
        if (publication) {
            raw = await generateProjectPageHtml(publication, bibtexData);
            const parsed = parseYamlFrontmatter(raw);
            frontmatter = parsed.attributes;
            body = parsed.body;
        } else {
            // Fallback to normal markdown processing
            raw = await fs.readFile(mdPath, "utf-8");
            const parsed = parseYamlFrontmatter(raw);
            frontmatter = parsed.attributes;
            body = parsed.body;
        }
    } else {
        // Parse markdown normally
        raw = await fs.readFile(mdPath, "utf-8");
        const parsed = parseYamlFrontmatter(raw);
        frontmatter = parsed.attributes;
        body = parsed.body;
    }

    // Convert to HTML
    let html = marked(body);

    // Configure DOMPurify to preserve IDs on headings
    html = purify.sanitize(html, {
        ADD_TAGS: ["iframe", "video", "audio", "source"],
        ADD_ATTR: [
            "target",
            "rel",
            "frameborder",
            "allowfullscreen",
            "autoplay",
            "controls",
            "onclick"
        ],
        ALLOW_DATA_ATTR: true,
        // Allow ID attribute on all elements (especially headings)
        ALLOWED_ATTR: [
            "href",
            "title",
            "id",
            "class",
            "src",
            "alt",
            "target",
            "rel",
            "frameborder",
            "allowfullscreen",
            "autoplay",
            "controls",
            "width",
            "height",
        ],
    });

    // Compute current page output path to correctly rebase assets
    const pageOut = computeOutputHtmlPath(mdPath, homeMdBasename);

    // Add heading ids and rebase asset src paths
    html = addHeadingIds(html);
    html = rebaseAssetSrcPaths(html, mdPath, pageOut);
    
    // Add padding to paragraphs before H2 headers (only on home page)
    if (mdPath.endsWith('HOME.md')) {
        html = addPaddingBeforeH2(html);
    }

    // Extract title with priority: frontmatter.title -> first H1 -> config.site_title
    let title;
    if (
        frontmatter &&
        typeof frontmatter.title === "string" &&
        frontmatter.title.trim()
    ) {
        title = String(frontmatter.title).trim();
    } else {
        try {
            title = parseFirstH1(body);
        } catch {
            title = config.site_title;
        }
    }

    // Extract description with priority: frontmatter.description -> title
    let description;
    if (
        frontmatter &&
        typeof frontmatter.description === "string" &&
        frontmatter.description.trim()
    ) {
        description = String(frontmatter.description).trim();
    } else {
        description = title;
    }

    // Build nav
    const homeOut = computeOutputHtmlPath(
        path.join(REPO_ROOT, config.home_md),
        homeMdBasename
    );
    const nav = buildNavHtml(
        navItems,
        pageOut,
        config.site_title,
        homeOut,
        navTemplate
    );

    // Get stylesheet path
    const stylePath = path
        .relative(path.dirname(pageOut), stylesheet)
        .split(path.sep)
        .join("/");

    // Build footer with correct relative logo sources
    // const cmuOut = path.join(OUTPUT_ROOT, "static", "logos", "cmu.png");
    const scsOut = path.join(OUTPUT_ROOT, "static", "logos", "cmuscs.svg");
    const csdOut = path.join(OUTPUT_ROOT, "static", "logos", "cmucsd.svg");
    const footerHtml = footerTemplate
        // .replace("{{CMU_LOGO_SRC}}", path.relative(path.dirname(pageOut), cmuOut).split(path.sep).join("/"))
        .replace("{{SCS_LOGO_SRC}}", path.relative(path.dirname(pageOut), scsOut).split(path.sep).join("/"))
        .replace("{{CSD_LOGO_SRC}}", path.relative(path.dirname(pageOut), csdOut).split(path.sep).join("/"));

    // Add home page class for specific styling
    const isHomePage = mdPath.endsWith('HOME.md');
    const bodyClass = isHomePage ? 'home-page' : '';
    
    // Build final HTML
    const finalHtml = template
        .replace("{{TITLE}}", escapeHtml(title))
        .replace("{{DESCRIPTION}}", escapeHtml(description))
        .replace("{{NAV}}", nav)
        .replace("{{STYLESHEET_HREF}}", stylePath)
        .replace("{{CONTENT}}", html)
        .replace("{{FOOTER}}", footerHtml)
        .replace('<body>', `<body class="${bodyClass}">`);

    // Write file
    await fs.mkdir(path.dirname(pageOut), { recursive: true });
    await fs.writeFile(pageOut, finalHtml);

    console.log(
        `✅ ${path.relative(REPO_ROOT, mdPath)} -> ${path.relative(
            REPO_ROOT,
            pageOut
        )}`
    );
}

// (Removed helper; 404 is now rendered from 404.md like any other page)

/*
End-to-end site build:
- Loads template/config, copies stylesheet, builds nav, copies static files
- Renders all markdown files into the output directory
*/
async function buildSite() {
    // Load everything
    const template = await fs.readFile(
        path.join(RENDER_ROOT, "template", "index.html"),
        "utf-8"
    );
    const navTemplate = await fs.readFile(
        path.join(RENDER_ROOT, "template", "nav.html"),
        "utf-8"
    );
    const footerTemplate = await fs.readFile(
        path.join(RENDER_ROOT, "template", "footer.html"),
        "utf-8"
    );
    const config = await loadConfig();
    const stylesheet = await copyStylesheet();
    const navItems = await buildNavItems(config, path.basename(config.home_md));
    const membersData = await loadMembersData();
    const researchData = await loadResearchData();
    const bibtexData = await loadBibtexData();
    const purify = DOMPurify(new JSDOM("").window);

    // Copy static files
    await copyTree(REPO_ROOT, OUTPUT_ROOT);

    // Clean up orphaned project directories first
    await cleanupProjectDirectories(researchData);
    
    // Create project page directories and index.md files
    if (researchData.publications && researchData.publications.length > 0) {
        for (const publication of researchData.publications) {
            const projectDir = path.join(REPO_ROOT, "research", publication.id);
            const indexPath = path.join(projectDir, "index.md");
            
            // Create directory if it doesn't exist
            await fs.mkdir(projectDir, { recursive: true });
            
            // Create index.md file if it doesn't exist
            try {
                await fs.access(indexPath);
            } catch {
                // File doesn't exist, create it
                await fs.writeFile(indexPath, `# ${publication.title}\n\n{{PROJECT_CONTENT}}`);
            }
        }
    }

    // Render all markdown
    const mdFiles = await findMarkdownFiles(REPO_ROOT);
    for (const mdPath of mdFiles) {
        await renderPage(mdPath, {
            template,
            purify,
            navItems,
            stylesheet,
            config,
            navTemplate,
            footerTemplate,
            membersData,
            researchData,
            bibtexData,
        });
    }

    console.log(`📁 Output: ${OUTPUT_ROOT}`);

    // 404 will be generated from root 404.md if present
}

buildSite();

