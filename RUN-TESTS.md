# Front-end tests (`z:\tmp\test-t*.mjs`)

They run in Node against **linkedom**, not in a browser: `document.execCommand`
does not exist outside one, so what is tested is everything around it — the
markup the editor generates, the class logic the toolbar applies, and the
save/load round trip through `js/api.js`. `t1`–`t14` and `t18` are the
editor (`write.html` + `js/write.js`); `t15` is the "all posts" page
(`viewall.html` + `js/viewall.js`, plus the one server route that feeds its
chip row); `t16` is the article page (`post.html` + `js/post.js`).

## Running them

```sh
mkdir -p /tmp/domtest && cd /tmp/domtest
npm init -y && npm install --no-audit --no-fund linkedom@0.18.9
cp z:/tmp/harness.mjs z:/tmp/rendercheck.mjs .
for f in z:/tmp/test-t*.mjs; do cp "$f" "$(basename "$f" | sed 's/^test-//')"; done
for t in t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 t11 t12 t13 t14 t15 t16 t17 t18 t19 t20 t21 t22 t23 t24 t25; do
  printf '%-5s ' $t; node $t.mjs >/dev/null 2>&1 && echo PASS || echo FAIL
done
```

`linkedom` is deliberately installed **outside** `z:\node_modules`: that tree
holds the ELF `better-sqlite3` build the Ubuntu server runs on, and nothing
about a test should touch it.

## What each one covers

| file | covers |
|---|---|
| `t1` | `<font>`/`<mark>`/inline-background → `.rt-size-*` `.rt-font-*` `.rt-mark`, and back; idempotence. Plus the colour rule, in all three places it is enforced: no literal ink (`color`, `<font color>`, `bgcolor`) and no literal background survives into the published HTML, into the editor, or into the database - the last checked against the real `sanitizeRichHtml()` required straight out of `server/` - while a pasted highlight still becomes `.rt-mark`, a `<font>` still keeps its size and its face, a pasted `font-weight` and a relative `font-size` still survive, and a post stored before the rule is cleaned on its way into the editor and stays clean on the way out |
| `t2` | indent `<blockquote>` ⇄ `div.rt-indent`, carrying block classes both ways; a real quote is left alone |
| `t3` | legacy blocks (`text` + bold/italic/size/font/indent/numbered) → editor markup → published HTML |
| `t4` | every block type rendered; tag balance; menu specimens; word count |
| `t5` | `rtApplyBlockClass` — group replacement, toggle, multi-paragraph, mixed selection, nested `<li>` |
| `t6` | read-only block lookup creates no `<p>`; clear-formatting scope; trigger values incl. a pasted face |
| `t7` | the docked bar: no per-block toolbars, `aria-pressed` sync, raising/lowering, `.rt-mark` |
| `t8` | the heading trigger ignores the selection and reads its own block |
| `t9` | author text (heading, caption, URL) cannot become markup |
| `t10` | the heading menu applied end-to-end, and focus landing on the rebuilt trigger |
| `t11` | the `role="toolbar"` keyboard contract: one tab stop, arrows, Home/End, trigger Down |
| `t12` | a docked button lands on the caret's block, not another; nothing happens with no caret |
| `t13` | every branch of `rtDockShouldOpen()` - editor, dock, open menu, title field |
| `t14` | images INSIDE a paragraph: the paste cleaner (what it drops, and the literal colours it now takes off - with `markInlineHighlights()` running first, so a pasted highlight becomes `.rt-mark` instead of being deleted along with the colour), the placeholder chip, the async upload swap (including across a `renderBlocks()` and after the block is deleted), the "Chèn ảnh" menu, the save filter, and the round trip to `post.html`. Also the adoption layer for a picture the BROWSER pasted: `data:` → `File`, sweeping such an `<img>` into an upload, dropping a dead `<img alt="">` the sanitizer already blanked, along with the empty `<div>` Chrome had wrapped it in, the save gate that strips them, and `rtClipboardImages` against a list that is array-like but not iterable |
| `t15` | the numbered pager on `viewall.html`: six posts a page, the windowed page numbers (`1 2 … 49 50 51 … 99 100`), turning/jumping/clamping a page, `?page=` in the URL, the same paging behind a tag chip and behind the search box, a deep link to a page that no longer exists, the in-flight and fetch-failed states, and - as plain text - that the page, the script and the stylesheet still agree (the `<nav>` exists, the "Xem thêm" button is gone from both, `#viewall-pager` does not out-rank `.hidden`, every colour is a token, both arrow icons are in `scripts/icon-names.py`). Also the chip list's source: the real `GET /api/posts/tags` handler lifted out of `server/routes/posts.js` and run against a fake `db`, asserting it counts the `tag` column only - a hashtag name must never become a chip, while `?tag=` keeps matching hashtags so a `#name` on a card still filters |
| `t16` | the article page: which pictures the lightbox takes (cover first, then the body in reading order, never one the author wrapped in a link), opening it by click and by Enter/Space on a focused picture, the counter and caption, walking the images (buttons, arrow keys, wrapping, and the swipe that replaces them on a phone), zoom (the +/- step, the ceiling and the floor, the wheel, double-click, two-finger pinch, and zooming about the point clicked rather than about the middle), pan (drag, and the clamp that stops a zoomed picture being dragged off its own edges), closing (Esc, the button, the backdrop - but not the click a drag ends with), focus going into the dialog and cycling inside it, the "read next" row (same topic first, newest of those first, topped up from the newest when the topic runs out, never the article being read, hidden when there is nothing to suggest or the request failed, titles escaped), the like/dislike pair no longer pushed right and the "về đầu trang" button sharing their row at its right-hand end (not a vote, named for a screen reader and for a pointer, scrolling to the top smoothly - or as a jump when `prefers-reduced-motion` says so), and - as plain text - that `post.html` and `post.js` still agree: every id the script reaches for exists, neither `.lightbox` nor `.related-section` out-ranks `.hidden`, what holds the back-to-top button right is `margin-left: auto` rather than a justify utility (a wrapped line holds one item, and one item sits at the start), every colour is a token, the overlay is above the nav, and the four icons it uses are literals in the markup so the subset font carries them. Plus the 2026-09-11 restyle, held down as CSS text because linkedom has no eye for a rim: the vote pills and the back-to-top pill carry NO border declaration at all (`border-radius` stays - it is what rounds the hover wash and the vote's fill), rest on `background: transparent`, and the vote is the FILLED GLYPH plus its colour and nothing else - no wash at rest, on hover, or once voted, because every wash tried here read on screen as the frame the reader asked to have removed (the hover wash caught by the reader's first screenshot of the live site, the voted pill by the second); and the back-to-top click runs a `to-top-pulse` zoom that post.js puts on at click and `animationend` takes off, skipped entirely under reduced motion like the smooth scroll beside it. The browser half of that contract is `z:\tmp\shoot-reactions.mjs`, which moves a real pointer onto the pill and measures the computed border width, the hover and voted backgrounds, the mid-animation scale and the settled transform on the real page. Plus the report's answer, restyled the same day: a TOAST in the site's own glass instead of a native `alert()` - `role="status"` on a polite live region, the message in through `textContent` because it is data the page just received, three left bars in the inbox's language (primary thank-you, outline withdrawal, error refusal), a z-index between the lightbox and the maintenance scrim, and a timer dismissal that still fires when reduced motion switches the animation off and with it the `animationend` the removal used to wait for; `moderation-ui.mjs` asserts the live toast and shoots it in both themes. Also the reading column: the comment box and its "Gửi" button take the ARTICLE's width rather than both tracks (the section is a grid of its own, both grids read the same two numbers off `#post-article` so `21rem` is written down exactly once, and "nothing to suggest" widens the article and the comments off that one condition), and the author's mark - a solid person-with-pencil `<svg>` in `currentColor`, at the byline row's own 18px, centred on the name by the link, its pencil knocked out of the shoulder by a mask rather than painted over it, because the subsetted icon font has no such glyph and an icon it does not carry renders as nothing |
| `t17` | tables in the paragraph editor: the Word-shaped grid the "Bảng" pill opens (ten across, eight down, the lit rectangle and its count), the table it inserts (a `<th scope="col">` head row over `<td>` rows, every cell a `<br>`, no class and no style), the operations under the grid (a row added above the heading stays up in `<thead>` and is a head row, a column added to a headed table keeps the head a head, the last row or column takes the whole table with it), `rtTableOp` end to end through a stubbed caret, Tab walking the cells and growing the table from the last cell Word's way while an ordinary key is left alone, the save filter counting an all-empty table as content, and the whole trip a table makes - `normalizeRichTextHtml`, `richTextToEditorHtml`, the server sanitizer (colspan kept, `onclick` not, every tag the picker writes in the allowlist), `renderContentBlocksHtml` - plus, as plain text, that the pill renders with `aria-haspopup="dialog"`, the picker's CSS and the shared table rules in `common.css` are tokens only, and `grid_view` is listed in `scripts/icon-names.py` |
| `t18` | quotations, both kinds the toolbar offers under the one Vietnamese name. BLOCK: `rtToggleQuote()` wrapping the caret's paragraph in `<blockquote class="rt-quote">`, three selected paragraphs sharing one panel, a second press taking it back off, and the lift that keeps a wrapper out of a structure's children - a caret in a `<td>` quotes the whole `<table>` and one in an `<li>` the whole `<ul>`, because a blockquote between `<tr>` and `<td>` loses the cell - plus blocks in different parents getting one panel each, and a selection reaching INTO an existing panel leaving it alone rather than nesting a second. Then the save pipeline, which is where the real risk is: `isIndentBlockquote()` retags every indent `<blockquote>` to `<div class="rt-indent">`, and it recognises one by the inline style `execCommand('indent')` leaves behind, so a quotation wearing that same style would be stored as a plain indent with its panel gone. Both directions are asserted - the quote survives, and a real indent (including the WebKit-marked one) is still converted - along with an indent made INSIDE a panel becoming a div inside it, the `stored -> editor -> stored` cycle, and the server sanitizer keeping `blockquote.rt-quote`. INLINE: `rtToggleInlineQuote()` against a stubbed `execCommand('insertText')` faithful to how every engine behaves (replace the selection, leave the caret collapsed after it), which is what makes the run stay selected and the second press a toggle - wrapping, unwrapping, folding a paste's straight or French pair rather than doubling it, taking only one mark per side, leaving a trailing apostrophe alone because it is the author's and not a quote mark, and with nothing selected writing the empty pair with the caret BETWEEN the two. Plus, as plain text, that the bar renders both buttons with the right `data-state`, that a quotation is TWO MARKS AND NO BOX - every declaration that drew the old frosted panel (`background`, `backdrop-filter`, `border`, `border-left`, `box-shadow`, `border-radius`, `padding`) is asserted absent while the italic, the size and the air around it are asserted present - that the marks are the high opening `“` and the low closing `„` set at newspaper scale (3em), and sit in the two corners a BROKEN FRAME leaves open - the frame is two pseudo-elements carrying two hairline sides each, each stopping at 60% and holding back from the marked corner so its vertical stroke never reaches the corner the mark on the other diagonal owns, the radius only on the two corners that actually close and the line in the page ink at 0.45 alpha so both themes get their own - while the blockquote itself is still asserted free of every declaration that drew the old frosted panel (fill, blur, shadow, thick rule), and they hang off the wrapper's first and last CHILD rather than off the `<blockquote>` (where they would land in an anonymous block of their own, the opening mark alone on the line above its sentence), that the selector excludes exactly the two signatures `execCommand('indent')` leaves behind so an indent can never grow a pair, that the inline pill and the block wrapper use the SAME pair (one site, one way of quoting), that a German `„…“` paste folds to it rather than doubling, that the editor shares the reading page's one rule scoped to `.rt-quote`, that the indent reset carries `:not(.rt-quote)` in both its desktop and phone copies, that everything is tokens only, and that `format_quote` is listed in `scripts/icon-names.py` |
| `t19` | the 2026-09-09 perf/security sweep, as assertions: `derivUrl()` moves only a bare same-origin `/uploads/<name>` path to its `thumb`/`w1280` derivative and leaves external covers, the empty string and an already-derived URL alone; `rewriteProseImages()` puts the 1280px copy plus `loading="lazy" decoding="async"` on every `<img>` in a post body without touching an attribute the author's markup already set; and, as plain text, that every reading page and template agrees - home's lead and post's hero ask for `w1280`, viewall's cards carry a two-entry `srcset`, related cards and the media-style tiles ask for `thumb`, no inline `on*=` handler survives on index/viewall/post/profile or in their scripts, no page links the font CDN while `fonts.css` declares the body family with its vietnamese `unicode-range`, the CSP's `font-src` is `'self'` alone, `server.js` routes both derivatives and marks `/api` `no-store`, `thumbs.js` knows both variants, the posts list query carries no `content` and is rate limited, views are batched, the three new indexes exist, and no `ORDER BY datetime(` remains |
| `t20` | the terms page and the footer contact row, driven through the REAL `server/render-html.js` with `server/db.js` stubbed in `require.cache` (its better-sqlite3 is a Linux binary and cannot load here), so the substitutions are tested the way the server runs them: `data-setting-mailto` builds `href="mailto:..."` while the visible label stays markup ("Liên hệ" in the footer, the address itself in clause 10 of the terms page), an empty or absent `contact_email` leaves the href off and hides the whole item, and every page's footer carries the row in the order Lien he > Dieu khoan > ban quyen with both attributes on ONE element - except the terms page, whose footer carries no link to the page the reader is already on. It also holds the bug the first draft shipped - the renderer matches its markers TEXTUALLY, so a marker spelled out inside an HTML comment was filled in as markup and printed the site name between a comment and its card; hence `parkComments()` in render-html.js, and the assertions that no rendered page has text where only a tag may follow a comment close, that every comment comes back, and that the brand is filled once per real attribute. Then the terms page as a page of the site (ten numbered clauses on the shared glass card, shared nav/search/footer, `.terms-body` in tokens only with list-style restated against Preflight, no inline handler, no font CDN), the admin `contact_email` field inside `#settings-form`, the api.js mirror of the mailto setting, and that every utility the footer row leans on exists in the COMPILED `tailwind.css` - the row once sat with its three items touching because `gap-x-5` had never been compiled |
| `t21` | the terms document an admin edits from the page itself, with the POST WRITER'S engine: the terms page loads `js/write.js` (its page wiring guards itself away without a `#post-form`) and links `css/write.css` - the chrome moved out of write.html's inline `<style>` so both pages share one toolbar - so a clause body is a contenteditable `.rt-editor` and every clause is sanitised by the same `server/sanitize-html.js` pass a post body gets. Asserts the two states through the REAL `renderHtml()` with a STATEFUL db stub (no row = shipped clauses and shipped date; a row replaces the sections, expands the `[brand]` and `[contact]` tokens into markers the later passes fill, and rewrites the date line from `updated_at`), the plumbing (fillTerms before the marker passes, the cache key, the table, the routes, the mount, the api.js wrappers, build-assets), the editor markup (hidden until `/auth/me` says admin, new clauses scrolled into view so the add button cannot look dead, live-region status, icons in the subset font), and the round trip that matters most: `terms.js`'s page->HTML conversion over the REAL shipped sections through linkedom, then `sanitizeRichHtml()` + token expansion, all ten identical to what the page ships - so an admin's first save cannot silently rewrite the document's wording |
| `t22` | the media bin's move, against a filesystem that lies: the seven `fs` calls server/media-store.js uses are swapped for an in-memory map (the real `public/uploads` is not something a test writes into) and the REAL `moveToTrash()` / `restoreFromTrash()` / `trash-store.trash()` run through one device, two devices (`rename` answering EXDEV, as a bind-mounted uploads directory makes it, must fall back to copy+unlink), a bin that refuses halfway through (whatever already moved goes back, so a failed trash never leaves an image split across the two trees), a bin that refuses outright, and a full disk - with the errno reaching both `console.error` and the sentence the admin is shown, because a bare "Không dời được ảnh vào thùng rác" is not anything anybody can act on. Then the case that actually happened on the Ubuntu box: a bin that EXISTS but belongs to somebody else (root-created by a deploy script run under sudo, pm2 running as an ordinary user), so every delete answered EACCES on the first file and the bin stayed empty forever. Empty and locked, the module rebuilds it and the delete succeeds; locked and NOT empty, it is reported and left strictly alone, because it may hold a pending restore. The fakes go in **before** the `require`, not after: the module probes its bin at load, and a real probe would write a scratch file into production `data/media-trash` over the Samba mount |
| `t23` | comment moderation - hiding, reporting, the admin inbox, and the mail that announces all three. The SCHEMA is held down as text, because db.js cannot be required here: `comments.hidden_at` in BOTH the CREATE TABLE a fresh database runs and the `migrate()` an upgraded one runs, its index inside `migrate()` and nowhere else (the schema block runs first, so an index on a column only migrate() adds would throw at every boot), `comment_reports` one-per-person-per-comment with its moderation outcome, and `notifications` with NO foreign keys at all - a row that describes an event has to outlive the event. Then the server modules loaded for REAL against a stateful in-memory db that answers exactly the statements they issue and THROWS on any other, so a renamed column fails instead of silently returning nothing: `comment-hidden.js` through a tree with a reply-to-a-reply and a reply hidden separately first (one stamp for the whole subtree, an unhide that clears precisely that group and never resurrects the other), and `notifications.js` - `record()` snapshotting actor/post/excerpt and cutting at 160, dropping an unknown kind rather than throwing, `list()` treating a filter that is not on the whitelist as "all" instead of interpolating it, and `mailAsync()` staying silent behind each of its three gates and SWALLOWING a refused delivery, asserted through a real `unhandledRejection` listener because every call site is a floating promise after the response. The ordering no unit test can see is asserted as text: `res.json()` before `mailAsync()` at all four write points, and the notification row written before the answer, so an admin panel reloading the inbox sees the event its own click caused. Then the reading page through linkedom for the three viewers of one hidden comment - the author gets a `role="status"` notice and their own words dimmed with no action row at all, an admin gets the row with a report count and Bỏ ẩn, and a reader who is neither (a payload the server never sends) gets a neutral notice and NOT the text, because rendering the words would undo the hide on the client - plus the report form's reasons arriving from the server rather than from a second copy in the page, one radio pre-checked, and the submit sending the checked reason with the note trimmed. Then the admin panel the same way: a report row is a `<div>` because a `<button>` inside an `<a>` navigates instead of acting, a row with nothing to click is a link to the post unless the post is gone, a LINKED row holds no anchor inside it at all - an `<a>` inside an `<a>` is a tree the browser repairs by closing the row early and lifting the post title out of the flex layout, which is how the title came to render on a line of its own; linkedom builds the impossible tree without complaint, so the markup assertion is the one that holds it, and the CDP harness `z:\tmp\moderation-ui.mjs` adds the layout half (the title's rect inside the sentence's rect) - one kind carrying both directions of the audit entry with the right eye and the right verb, mark-read landing BEFORE the navigation it defers, the badge capping at `99+`, and the four email toggles riding one list into the payload as `'0'` when they are unticked - the case FormData would drop. Last, that every colour the feature adds is a token that exists in both themes, and that the subset icon font carries `flag` |

| `t24` | `GET /sitemap.xml` - the generated document and the route it hangs on. The only harness that BOOTS `server/server.js` and makes real HTTP requests to it (`t19`/`t21` read it as text, `t20`/`t23` require individual modules), because whether a new top-level path survives `securityHeaders → compress → cors → json → cookieParser → passport →` the nine `/api` mounts `→ htmlRenderer →` the `.bak` blocker `→` the thumb/w1280 derivatives `→` the `.min` twin rewrite `→ express.static →` the `/api` 404 is a question about the whole chain and not about one handler. `db.js` is stubbed as in `t23` - recognised statements answered, anything else recorded during boot and THROWN on afterwards, so a renamed column fails instead of quietly returning nothing; besides the sitemap's own three the stub knows the statements its neighbour probes issue (`settings`, `terms`, `/api/posts/tags`, and `render-html.js`'s `LEAD_SQL`). Asserted: the origin comes from `SITE_URL` with its trailing slash stripped and never from the request's Host header; `datetime('now')` becomes a W3C `+00:00` timestamp instead of being parsed as local time, a value that already carries an offset is CONVERTED rather than relabelled, and an unparseable one omits `<lastmod>` outright rather than guessing; a slug holding `& < > "` is percent-encoded into its `<loc>` and all five XML entities escaped so no bare `&` survives; `/` is listed once and `/index.html` not at all, `?tag=`/`?q=` filtered duplicates and the login-gated `/write.html` and `/admin.html` are absent; every `<url>` carries all four protocol children with a `<changefreq>` from the allowed set and a `<priority>` at one decimal. Then the caching contract - a weak ETag derived from the data fingerprint, `public, max-age=3600`, byte-identical repeat output, 304 on a matching `If-None-Match` and on `*`, a full 200 on a superseded one, still gzipped by `compress.js` - measured over raw `http.get`, because undici answers a conditional request out of its own cache and reports 200 for what the server sent as 304. Then that a publish, an un-publish and a blank slug each move the document on the NEXT request with no TTL to wait out; that the homepage's and the listing's `<lastmod>` is `MAX(updated_at)` over the whole published set and NOT the top of the created_at-ordered post list - fixing a typo in last month's article re-renders both pages, and reading the date off the newest post hides that, which is what the stub's own `MAX()` is there to catch; that an empty database still yields a complete three-page document whose homepage omits `<lastmod>` while the terms page keeps the one from its saved document; and that with the database down the handler answers 200 with the three fixed pages under `no-store` - not a 500, and not a copy Cloudflare would go on serving for an hour after the database came back. Last, that HEAD returns the headers with no body and POST/PUT/DELETE 404 |
| `t25` | the maintenance notice - one card with three doors. THE PAGE (`public/maintenance.html`, which the server answers when `data/maintenance-on` exists or a request dies in a 5xx) must depend on nothing that could be part of the problem: no `tailwind.css` (its Preflight is replaced by a three-line reset of the page's own), no `api.js`, exactly one `<script src>` (the blocking theme switch), the copy carried over from the draft in `z:\tmp\maintenance-index.html`, the wrench as an inline `<svg>` because the subsetted icon font carries no wrench glyph, and every colour a token so the dark theme restyles it for free - plus the flat backdrop: no gradient anywhere on it. THE SWITCH (`server/maintenance.js`) is loaded for REAL against a fake `fs` in `require.cache`, because the flag it stats is `data/maintenance-on` in the LIVE tree and a test that created it to watch the middleware fire would take anonyht.com down for as long as the file lived: `isEnabled()` follows the stat, the notice and its `css/js/fonts/uploads` assets are the only paths let through, everything else becomes the page at 503 with `no-cache` and `Retry-After` (a 200 notice is one a CDN keeps serving after the flag goes), and a notice that cannot itself be read degrades to plain words rather than throwing from inside the error path. Then, as text, WHERE it is hung: the middleware before the first `/api` mount, and the error handler's 5xx branch handing a reader - not an API caller, which keeps its JSON - to `maintenance.sendPage`. THE PANEL (`api.js`) is what a reader gets when the server vanishes mid-page: run through linkedom against a stubbed `fetch`, a thrown fetch and a 5xx each raise the `alertdialog` card exactly once however many requests die, a 4xx raises nothing because that is the reader's own input and every form already answers for itself, and a healthy request returns its data over an empty body. The browser half is `z:\tmp\shoot-maintenance.mjs`: the page and the panel in both themes |

`z:\tmp` was cleaned up once already and the harnesses went with it, so all seventeen
are stored there again under the `test-t*.mjs` names the recipe above copies from -
`t14`, `t15` and `t16` included, though all three carry their own loaders and need
neither `harness.mjs` nor `rendercheck.mjs`. `t24` needs neither those nor linkedom and
is not a front-end test at all: it boots `server/server.js` and talks to it over HTTP, so
its only dependency is `Z:\node_modules` for express, reached through the absolute
`Z:\server\...` paths it requires (which is why it can be copied anywhere and still run). `t1` used to be a printed report with nothing
asserted in it: it could not fail, and the round trip it printed - including the `[DRIFT]`
marker - was only ever checked by eye. It now asserts every case it prints (105
assertions), drift included, and reaches into `server/sanitize-html.js` with
`createRequire` the way `t14` and `t15` do, because a colour rule that holds on the page
and not in the database is half a rule. `t3` used to read `z:\tmp\nw.js`, a snapshot
of `write.js` that went with the directory; it now reads `z:\public\js\write.js`, which is
what it should have been testing all along. `t15` and `t16` parse the REAL page
(`public/viewall.html`, `public/post.html`) rather than a hand-written skeleton, so they
fail when a page and its script disagree about what is on the page — which is how the
"Xem thêm" button `t15` replaced would come back. `t16` also renders its article body
through the real `parseContentBlocks()` + `renderContentBlocksHtml()`, so the pictures the
lightbox collects are the pictures a published post actually contains.

## linkedom gaps the harnesses paper over

All are noted in the harness files where they are worked around.

1. `template.content` is not live and has no `textContent`, so `rewriteRichText()`
   would return its input unchanged. A detached `<div>` is substituted, and every
   `tpl.content` read with it — `t1`–`t13` only needed the `.textContent` member,
   `t14` also goes through `.querySelectorAll` and `.firstElementChild`.
2. CSS shorthands are not expanded into longhands, so `margin: 0 0 0 40px` leaves
   `style.marginLeft` empty — exactly what `isIndentBlockquote()` reads.
   `RT_INDENT_STYLE` and the test fixtures are rewritten to longhands.

Neither is a gap in the code under test; both work in every browser.

And the things stubbed rather than worked around. They are listed here rather than
in the table because every test relies on the first four:

- `window.getSelection()` — linkedom has no `Range`, so the tests supply an object
  carrying the three members the code touches: `anchorNode`,
  `getRangeAt(0).startContainer` and `intersectsNode`, the last answering from a
  list of nodes the test declares as selected. That is exactly the contract
  `rtSelectedBlocks()` relies on.
- `focus()` — linkedom's is a no-op that never sets `document.activeElement`, so
  `t10` and `t11` instrument the method on the prototype instead of reading it.
- `document.activeElement` — undefined in linkedom, and the docked bar's visibility
  is decided from it, so the render harness makes it settable and exports
  `setActiveElement()`.
- `new Event(...)` — Node's global `Event` cannot be dispatched into a linkedom
  tree (its `eventPhase` is getter-only), so `t11` uses the `dom.Event` the
  render harness re-exports.

Three more, only `t14` needs them, because it is the one test that loads write.js
past its `// ---- Page init ----` marker and drives a save:

- `form.hashtags_input` — named-property access on a `<form>` is a browser thing
  linkedom does not do, so the one line that reads it is rewritten to a
  `querySelector`.
- `window.location` — not assignable in linkedom, and a successful save navigates.
- `new FormData(form)` — Node's `FormData` takes no form element; the stub answers
  `get(name)` from the form's own inputs and returns `null` for an unticked
  checkbox, which is what decides draft-vs-published.

Five more, only `t15` needs them, because it runs a whole page script rather than
functions lifted out of one — and then lifts one server handler the same way:

- `db` / `res` for `GET /api/posts/tags` — `better-sqlite3` is an ELF build, so
  `server/routes/posts.js` cannot be imported here. The handler is sliced out of the
  file by text and run with a `db` whose `prepare()` records the SQL and returns
  canned rows, and a `res` that captures the JSON. The rows deliberately carry a
  `hashtags` column that `SELECT tag` would never return, so a hashtag name showing
  up in the answer can only have come from the handler reading it.

- `scrollIntoView()` — absent in linkedom, and `renderTagFilters()` uses it to bring
  the active chip into view. An absent method would reject that async function, and
  an unhandled rejection ends the process, so the loader puts a no-op on the element
  prototype.
- `window.scrollTo()` — `gotoPage()` and `selectTag()` scroll the reader back to the
  top of the new page. Recorded rather than no-oped, so "the page turn scrolled" is
  one of the assertions.
- `location` / `history.replaceState` — the whole view lives in the query string, so
  both are passed into the script as parameters: a fresh `{pathname, search}` per
  scenario (which is how a `?page=9` deep link is tested) and a `replaceState` that
  collects the URLs instead of changing one.
- `API.listPosts` / `API.listTags` / `getSiteSettings` — no server is reachable from
  this machine (`better-sqlite3` is an ELF build; port 3000 is the Ubuntu box). The
  stub does what `server/routes/posts.js` does — filter, `COUNT(*)`, `LIMIT/OFFSET`
  newest first — over 25 fake posts, so the paging arithmetic under test is the
  client's and not a canned answer shaped to suit it.

`document.execCommand` is not stubbed in `t15`: that page has no editor. It does need
linkedom's own `Event` for the click and input dispatches, for the same reason `t11`
does.

Five more, only `t16` needs them, because a lightbox is nothing but layout and
gestures and linkedom has neither:

- **No layout at all** — `offsetWidth`, `clientWidth` and `getBoundingClientRect()`
  answer 0, and the zoom/pan arithmetic reads all three (the picture's size, the
  stage's size, and where the centre of the stage is on screen). Supplied as fixed
  numbers: a 1000x800 stage at the origin and a 500x400 picture, which makes every
  clamp and every "the point under the cursor stays under the cursor" check a number
  that can be written down. `offsetWidth` rather than `getBoundingClientRect().width`
  is what the code reads for the picture, on purpose: the rect carries the transform,
  and the transform is mid-transition while a finger is dragging.
- `focus()` — as in `t10`/`t11`, recorded instead of read. It lives on
  `Element.prototype` in linkedom (not on `HTMLImageElement`/`HTMLButtonElement`), so
  one patch there instruments every element on the page.
- `document.activeElement` — undefined, and the focus trap decides from it, so the
  loader makes it settable and the test says where focus is.
- Event geometry — `new Event('pointermove')` carries no `clientX`/`pointerId`, so the
  helper builds linkedom's `Event` and `Object.assign`s the coordinates on. They are
  plain own properties, which is enough for code that only reads them.
- `window.scrollTo()` / `window.matchMedia()` — as in `t15`, recorded rather than
  no-oped, because the "về đầu trang" button does nothing *except* scroll: the
  assertion is the call itself, `{top: 0}` and which `behavior` came with it.
  `matchMedia` is absent too, and it is how that button asks whether the reader
  wants the scroll animated, so the fake window answers from a flag the test sets.
  `window.addEventListener` is a no-op on the same fake window; the only thing
  registering there is the reading-progress bar's scroll listener.

Its `API.listPosts` stub sorts by `created_at` descending like the real route does. It
did not at first, and the "read next" assertions passed against an order the server never
returns — a stub that is merely *plausible* tests nothing.

Six more, only `t23` needs them, because it runs server modules and two whole page
scripts against a database that is not there:

- **`server/db.js`** — replaced in `require.cache` by a small SQL engine rather than a
  canned answer: a `Map` of comments, an array of notifications, and handlers for the
  exact statements `site.js`, `email-config.js`, `notifications.js`, `comment-hidden.js`
  and `trash-store.js` issue. Anything else **throws**, which is the point — a stub that
  returns `[]` for a statement it does not recognise turns a renamed column into a pass.
  `db.transaction(fn)` is `(...args) => fn(...args)`, enough for `ensureEmailSettings()`
  and `saveEmailSettings()`.
- **`server/mailer.js`** — stubbed to record calls, so "which events reach the mailer"
  is the assertion and nodemailer is never loaded. It can be told to reject, which is how
  the swallowed-rejection case is driven; `trash-store.js` is loaded for REAL, because
  `comment-hidden.js` borrows `stamp()` and `commentSubtree()` from it and a stubbed copy
  would test the stub.
- **`api.js` is sliced, not loaded** — from `function escapeHtml(` to `let authFlow`,
  which is where its page wiring begins. Taking the whole file evaluates the top-level
  `document.addEventListener` calls against a document the slice was never given.
- **Named access on a `<form>`** — as in `t14`: `form.notify_new_comment` is `undefined`
  in linkedom, and the email panel reads every field that way, so the test builds the
  mapping the browser would have (`input[name]` → `form[name]`) instead of changing how
  the code asks.
- **`checked` is not reflected** — linkedom leaves `input.checked` `undefined` for an
  `<input ... checked>` and its `:checked` selector reads the ATTRIBUTE, so the test moves
  a radio group with `setAttribute`/`removeAttribute`. That is also exactly what the
  renderer writes, so the assertion is on the markup a browser would parse.
- **`window.location.assign`** — recorded, because the inbox row defers its navigation
  until the mark-read has landed, and "navigated, in that order" is the assertion.
