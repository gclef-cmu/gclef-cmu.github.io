# Updating Team, Publications, and Supporters

This repo manages team profiles and publications via JSON files + static assets.  


## 👥 Add a Team Member

1. **Headshot** → place in `static/headshots/`  
   Example: `static/headshots/newstudent.jpeg`

2. **Update JSON** → edit `team/members.json`  
   Add entry under `faculty`, `students`, or `alumni`:

   ```json
   {
     "name": "New Student",
     "type": "Ph.D. Student",
     "department": "Computer Science",
     "email": "newstudent@cmu.edu",
     "website": "https://newstudent.com",
     "photo": "newstudent.jpeg"
   }
   ```

   For alumni, make sure to add a `status` field to indicate their current position.


## 📄 Add a Publication

1. **Choose an `id`** (unique, lowercase, no spaces, e.g. `2025newpaper`).

2. **Update JSON** → edit `research/research.json`

   Add entry inside `"publications"`:
   ```json
   {
     "id": "2025newpaper",
     "nickname": "New Paper",
     "title": "Title of the New Paper",
     "year": "2025",
     "venue": "CHI",
     "authors": "Jane Doe, John Smith, Alex Example",
     "abstract": "This paper explores how interactive AI systems ...",
     "award": "",
     "project_link": "https://example.com/newpaperdemo",
     "blog_link": "",
     "video_link": "https://bit.ly/newpaperdemo-chi2025",
     "code_link": "https://github.com/example/newpaperdemo"
   }
   ```
    
    - `nickname` field is used in the **Recent Highlights** section of `HOME.md`.

3. **Assets (use same `{id}`)**

   * PDF → `static/pdfs/{id}.pdf`
   * Preview image → `static/previews/{id}.{file_extension}` (e.g., `2025newpaper.png`)
   * BibTeX entry → in `research/bibtex.bib`:

     ```bibtex
     @inproceedings{2025newpaper,
        title     = {Title of the New Paper},
        author    = {Doe, Jane and Smith, John and Example, Alex},
        booktitle = {Proceedings of the 2025 ...},
        year      = {2025},
        url       = {https://example.com/newpaperdemo},
        abstract  = {This paper explores how...}
        }
     ```

## 🏢 Add a Supporter

1. **Logo** → place in `static/logos/`  
   Example: `static/logos/newsupporter.webp`

2. **Update JSON** → edit `supporters.json`  
   Add entry to the supporters array:

   ```json
   {
     "name": "New Supporter",
     "image": "static/logos/newsupporter.webp",
     "link": "https://newsupporter.com"
   }
   ```


<br><br>

# 💻 Local Debugging Guide

### 1. Install Node.js
```bash
# macOS
brew install node

# conda environment
conda install conda-forge::nodejs
```

### 2. Install Dependencies
```bash
cd your-git-dir
npm install
```

### 3. Start a Local Server
Use Python's built-in HTTP server to preview the site.
Access it via http://localhost:4000 (or whichever port you choose).
```bash
# serves files from the _site/ directory on port 4000
python3 -m http.server --directory _site 4000
```

### 4. Build the Site
Compile the source files (run this whenever you make code changes):
```bash
node .render/render.js
```