# Design canvas guide (read once per session)

You draw screens and components as HTML boards. The plugin renders each board with the
project's own Tailwind, in light and dark, and shows it on a canvas beside this session.

## Folder layout (the canvas folder returned by design_open)
- `design.json`: project repo, dark-mode switch and the css a board needs besides Tailwind
  (see "design.json" below). Adjust it only if renders look wrong.
- `canvas.json`: board index (x, y, w, h, order). Create boards with `design_board`, never by hand.
- `boards/<name>.html`: one board per file. Plain HTML, no scripts, no `<html>`/`<body>` wrapper.
- `components/<Name>.html`: reusable pieces (PascalCase file name).

## Workflow
1. `design_board { name, w }` registers the board and returns the `.html` path.
2. Write or edit that file with Write/Edit. The plugin re-renders on save and the canvas updates.
3. Call `design_render` and LOOK at both the light and dark images. Fix what is wrong and render
   again. Do not tell the user it is done before you checked both themes.
4. `design_focus` points the user's canvas at a board; `design_list` shows boards and components.

## Codes from the canvas (`@n…`)
The user selects an element on the canvas and pastes its code (`@n12`) in the chat.
Gestures (the user's side, for context): wheel zooms around the cursor; middle button or space + drag
pans (left-drag never pans); click selects a component, double-click goes into it; Ctrl+C or right-click →
"Copiar código" copies the `@n…`; double-click a screen's label renames it (title only). The user calls boards "telas".
- A `@n…` in the user's message → call `design_ref { ref: "@n12" }` BEFORE editing. It returns the
  board, the exact file:line and snippet to edit, and an image of the element. Edit that spot only.
- A code points at one instance: three `<x-item>` on a board are three codes. For an element of a
  component, design_ref gives the instance (the `<x-…>` call on the board) AND the component file,
  with how many boards use it. Decide by the request:
  - about this occurrence ("muda o texto deste", a param) → edit the instance (the call);
  - about the component's style or structure ("muda o estilo do item") → edit the component file and
    tell the user it changes every board that uses it.
- `código vencido: selecione de novo` means the source changed since the copy: ask the user to
  select the element again; do not guess.

## Rules for boards
- Use only the project's Tailwind classes and its color families (design_open prints them above
  this guide, in the line `cores do tailwind do projeto`). When that line says the project has no
  Tailwind, use the default Tailwind v4 palette.
- Standalone canvas: pass `repo` = the canvas folder; without Tailwind it uses the default v4 palette.
  No arbitrary hex colors, no inline styles for color, no invented class names.
- Dark mode: use the project's `dark:` variants or its theme variables; the plugin toggles the
  switch declared in design.json. Check that text stays readable in both.
- Widths: desktop 1440, mobile 390 (tablet 768). Omit `h` to let the height follow the content.
- Copy inside boards is PT-BR. Never put notes, labels or explanations inside a board; explain in
  the chat instead.
- Use realistic content (names, amounts, dates), not lorem ipsum.

## design.json
- `repo`: the project whose Tailwind renders the boards.
- `darkMode`: how dark is switched on, `{ "class": "dark" }` or `{ "attr": "data-theme", "value": "dark" }`.
- `css`: stylesheets of the repo (paths relative to it) compiled before Tailwind. Projects whose
  colors are CSS variables (`rgb(var(--slate-3) / <alpha-value>)`) need the file that defines those
  variables here, or every such color comes out empty and light looks like dark. design_open fills
  it when it finds them; for the SAC it is
  `"css": ["app/javascript/dashboard/assets/scss/_next-colors.scss"]`. Without sass, a `.scss`
  only contributes its plain custom-property blocks (`:root { --x: … }`, `.dark { --x: … }`).
- `brand`: a css file (relative to the canvas folder) loaded after the project css, for the
  company's own palette on top of the project's. The SAC uses one per company, e.g.
  `"brand": "brands/ninepay.css"` with `:root:root { --blue-9: 73 13 191; … }` and
  `.dark.dark { … }` overrides. `null` when the project's colors are enough.
- `head`: raw HTML added to every board's `<head>` (a font `<link>`, a `<style>`). Usually `""`.

## Components
Create `components/Toast.html`, use it as `<x-toast text="Salvo" tone="success"></x-toast>`
(tag = `x-` + kebab-case file name; self-closing `<x-toast />` works too).
- `{{ text }}` is the param, HTML-escaped; `{{{ html }}}` is raw.
- `<slot></slot>` receives the children written between the tags.
- Components can use other components. Editing one re-renders every board that uses it.
- Errors (missing component, unclosed tag, cycle) show up as a board error in design_render.

## Reading results
design_render returns one line per board (size, ms, error or "cortada" when the page is taller
than the image limit) plus the images. A board with an error keeps its previous image on the canvas.

## Comments
The user leaves comments on elements (right-click, "Comentar…") and then asks you to "faz os comentários"
(do the comments). Then: `design_comments` (open ones only); for each, first `design_ref <code>` (marks the
element and shows the snippet), then edit what it asks for (never guess a stale or unknown code) and call
`design_comment_reply` with what changed and `done: true`. When in doubt, or if it could not be done, reply
with `done: false`: the comment stays open. Done comments stay on the canvas until the user deletes them.
