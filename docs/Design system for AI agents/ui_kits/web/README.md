# AI Qadam Web UI Kit

Interactive click-through recreation of the AI Qadam country website. Three screens: country homepage, event detail, user profile.

## Open

Open `index.html` in a browser — no build required.

## Screens

| Screen | Description |
|---|---|
| **Homepage** (`uz.aiqadam.com`) | Hero with next event + upcoming events grid + about section |
| **Event detail** (`/events/ai-qadam-4`) | Breadcrumbs + title + tabs (About / Agenda / Speakers / Location) + registration sidebar |
| **User profile** (`/u/abdu`) | Profile header + stats + badges + activity feed |

## Navigation

- Click any event card → event detail page
- Click the logo → back to homepage
- Click the user avatar (top-right) → profile page
- Click the ← back link → previous page
- Dark/light toggle: ☀️/🌙 button in the header

## CSS

Links to `../../styles.css` (project root). Fonts loaded from Google Fonts. No build, no framework — vanilla HTML + CSS + JS.

## Notes

- This is a **visual recreation**, not production code
- All content is representative mock data
- Interactive states (hover, focus) are wired via the component CSS classes
- Theme toggle applies `data-theme="dark"` / `data-theme="light"` to `<html>`
