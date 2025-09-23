# How to Add Team Members & Publications

This repo manages team profiles and publications via JSON files + static assets.  


## 👥 Add a Team Member

1. **Headshot** → place in `static/headshots/`  
   Example: `static/headshots/newstudent.jpeg`

2. **Update JSON** → edit `team/members.json`  
   Add entry under `faculty` or `students`:

   ```json
   {
     "name": "New Student",
     "type": "Ph.D. Student",
     "department": "Computer Science",
     "email": "newstudent@cmu.edu",
     "website": "https://newstudent.com",
     "photo": "newstudent.jpeg"
   }



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

