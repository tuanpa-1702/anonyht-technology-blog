// UI-only: the footer year (all API/auth logic stays in /js/api.js + /js/write.js).
document.getElementById('footer-year').textContent = new Date().getFullYear();

const editParams = new URLSearchParams(window.location.search);
const editId = editParams.get('id');
let editingPost = null;

// ---- Block editor state ----
// blocks: [{ type: 'paragraph', text }, { type: 'heading', text, level }, { type: 'image', url, caption }]
let blocks = [];
let nextBlockKey = 1;

function newBlock(type) {
  const base = { key: nextBlockKey++, type };
  if (type === 'heading') return { ...base, text: '', level: 2 };
  if (type === 'image') return { ...base, url: '', caption: '' };
  // "Bố cục ảnh": one of IMAGE_LAYOUTS (js/api.js), its pictures (url + alt),
  // a caption, and rich text for the layouts that sit beside prose.
  if (type === 'layout') return { ...base, layout: 'side', images: [], caption: '', html: '' };
  // An embed keeps the pasted url alongside the resolved src: the url is what the
  // author recognises and can correct, the src is what the page frames. `src` stays
  // empty until POST /api/posts/embed resolves it, and an empty src renders nothing.
  if (type === 'embed') {
    return { ...base, url: '', src: '', provider: '', title: '', ratio: '', height: null, caption: '' };
  }
  return { ...base, html: '' }; // paragraph - rich text, stored as sanitized HTML
}

// Older posts store paragraph blocks as plain `text` (optionally with
// block-level bold/italic/size/font/indent/numbered flags from an earlier
// version of this editor, or no flags at all for truly legacy plain-text
// posts). Converts any of those into the `html` field the rich-text editor
// expects, so opening an old post for editing doesn't lose its content.
//
// The old flags are written out in the STORED spelling - the .rt-size-*,
// .rt-font-* and .rt-indent classes - and then handed to richTextToEditorHtml()
// like any other saved block. Two things fall out of that. There is ONE path into
// the editor rather than two, so nothing can drift; and the marks arrive as the
// <font> and <blockquote> execCommand understands, which is what makes the
// toolbar work on a legacy post: the "Cỡ chữ" pill reads the <font> the caret is
// in, shows "Lớn", and REPLACES it on the next pick. An inline
// `font-size:1.5rem` - which is what this function used to emit - was invisible
// to the picker, so a second choice nested inside the first.
function migrateBlockForEditing(b) {
  if (b.type === 'layout') {
    return {
      ...b,
      images: (Array.isArray(b.images) ? b.images : []).map((im) => ({ ...im })),
      html: richTextToEditorHtml(b.html || ''),
    };
  }
  if (b.type !== 'paragraph') return b;
  if (b.html !== undefined) return { ...b, html: richTextToEditorHtml(b.html) };
  let html = escapeHtml(b.text || '').replace(/\n/g, '<br>');
  if (b.numbered) {
    const items = String(b.text || '')
      .split('\n')
      .filter((line) => line.trim().length)
      .map((line) => `<li>${escapeHtml(line)}</li>`)
      .join('');
    html = `<ol>${items}</ol>`;
  }
  if (b.bold) html = `<b>${html}</b>`;
  if (b.italic) html = `<i>${html}</i>`;
  // The two old sizes were 1rem and 1.5rem against a 1.2rem paragraph - which is
  // what "smaller" and "larger" are in the new scale.
  const marks = [
    b.size === 'sm' ? 'rt-size-sm' : b.size === 'lg' ? 'rt-size-lg' : '',
    b.font === 'serif' ? 'rt-font-serif' : b.font === 'mono' ? 'rt-font-mono' : '',
  ].filter(Boolean);
  if (marks.length) html = `<span class="${marks.join(' ')}">${html}</span>`;
  // The old flag shifted the WHOLE block by 2rem, which is this editor's
  // "lùi cả đoạn" - not the new first-line indent.
  if (b.indent) html = `<div class="rt-indent">${html}</div>`;
  return { type: 'paragraph', html: richTextToEditorHtml(html) };
}

// ---- The paragraph toolbar -------------------------------------------------
// One table, read by rtToolbarHtml() below and by scripts/icon-names.py (which
// cannot scrape these: every icon reaches the DOM as `${item.icon}`, so each one
// is listed in that script's DYNAMIC array - an icon missing from the subsetted
// font renders as NOTHING, not as a fallback glyph).
//
// There are three KINDS of control here, and the difference is not cosmetic:
//
//   cmd    document.execCommand - a CHARACTER-level mark. Applies to the
//          selected run, splits and merges runs correctly, and is undoable by
//          the browser's own undo stack.
//   klass  a class on the BLOCK element the caret sits in - alignment, the
//          first-line indent, leading, paragraph spacing. execCommand has no
//          command for the first-line indent at all, and for the other three its
//          commands write inline styles that normalizeInheritedTypography()
//          strips on save (it removes inline line-height unconditionally,
//          because a paste from Google Docs arrives with
//          `line-height: 1.15 !important`). Classes are the only spelling that
//          survives the trip through the save pipeline.
//   menu   opens one of RT_MENUS, a custom listbox. The native <select> these
//          replaced could not be made of glass - the OS draws the popup - and on
//          the dark theme it did not even render dark, because
//          `option { background-color: #fff }` overrides what `color-scheme:
//          dark` would have given it. Same problem, same fix as the role picker
//          in admin.html.
//
// `state` says how the pressed look is decided, and every button gets one so the
// toolbar reflects where the caret actually IS rather than what was last
// clicked: 'cmd' asks document.queryCommandState(), 'mark' and 'klass' look at
// the DOM around the selection, and 'none' is for the buttons that have no
// on/off state to show (undo, redo, indent, clear).
const RT_ALIGN_CLASSES = ['rt-align-left', 'rt-align-center', 'rt-align-right', 'rt-align-justify'];
const RT_LH_CLASSES = ['rt-lh-tight', 'rt-lh-snug', 'rt-lh-normal', 'rt-lh-relaxed', 'rt-lh-loose'];
const RT_SPACE_CLASSES = ['rt-space-none', 'rt-space-sm', 'rt-space-md', 'rt-space-lg'];
const RT_FIRST_LINE_CLASS = 'rt-first-line';
// Every class this toolbar can put on a block, which is also exactly what "Xoá
// định dạng" takes off - execCommand('removeFormat') only knows about the
// character-level marks it wrote itself.
const RT_BLOCK_CLASSES = [...RT_ALIGN_CLASSES, ...RT_LH_CLASSES, ...RT_SPACE_CLASSES, RT_FIRST_LINE_CLASS];

const RT_TOOLBAR = [
  // Paragraph style: "Đoạn văn thường" / "Tiêu đề 2" / "Tiêu đề 3" on whichever
  // line the caret is in - first in the bar, the same position this control
  // sits in every editor it is modelled on (Word, Docs). See RT_MENUS.headingFormat
  // above for what it writes and why h1 is not one of its options.
  { kind: 'menu', menu: 'headingFormat', icon: 'title', title: 'Định dạng đoạn (tiêu đề)' },
  { kind: 'sep' },
  { kind: 'cmd', cmd: 'bold', label: 'B', title: 'Đậm (Ctrl+B)', btnClass: 'rt-btn--bold', state: 'cmd' },
  { kind: 'cmd', cmd: 'italic', label: 'I', title: 'Nghiêng (Ctrl+I)', btnClass: 'rt-btn--italic', state: 'cmd' },
  { kind: 'cmd', cmd: 'underline', label: 'U', title: 'Gạch chân (Ctrl+U)', btnClass: 'rt-btn--underline', state: 'cmd' },
  { kind: 'cmd', cmd: 'strikeThrough', icon: 'format_strikethrough', title: 'Gạch ngang', state: 'cmd' },
  // Quotation marks around the selected run. A CHARACTER-level mark, so it sits
  // with B/I/U and not down among the block controls. Labelled with the two
  // glyphs it writes rather than with an icon: the pair is its own picture, and
  // the one quotation-mark ligature the icon font carries - format_quote - is
  // the block button's below, so a second icon here would be two pictures of
  // the same idea on one bar.
  { kind: 'quoteInline', label: '“„', title: 'Ngoặc kép — bôi đen chữ rồi bấm, bấm lại để bỏ', btnClass: 'rt-btn--quotemark', state: 'none' },
  // Hyperlink, Word-style: the button opens a small dialog asking for the address
  // and the display text, and the apply step writes the <a> itself. Not a plain
  // execCommand dispatch because a link needs a URL from the author first. The
  // sanitizer already allows <a href> with safe schemes, so what this writes
  // survives the save pipeline and renders styled on the reading page.
  { kind: 'link', icon: 'link', title: 'Chèn / sửa liên kết (Ctrl+K)', state: 'link' },
  // The colour is not passed here: js/api.js markInlineHighlights() converts
  // whatever execCommand wrote into .rt-mark straight after the press, and the
  // class carries the themed pair. A literal #fef08a - which is what this button
  // used to send - survived into the dark theme and put pale yellow behind
  // near-white ink. The value below only has to be A colour for the command to
  // fire; the theme decides the actual one.
  { kind: 'cmd', cmd: 'hiliteColor', value: '#fef08a', icon: 'ink_highlighter', title: 'Tô sáng', state: 'mark' },
  // An image at the caret, INSIDE the paragraph - as distinct from "+ Ảnh" on the
  // rail, which appends a whole image block after the last block. A menu rather
  // than one button because there are three ways in (a file on this machine, the
  // library, a URL that already exists), and the same three sit on the image
  // block: one vocabulary for "get me a picture" wherever it is asked for.
  // Pasting a copied screenshot does the same thing with no button at all - see
  // the paste handler further down.
  { kind: 'menu', menu: 'image', icon: 'image', title: 'Chèn ảnh vào đoạn văn', state: 'none' },
  // Table, Word-style: the pill opens a grid - ten across, eight down - where
  // the rectangle under the pointer is the table you are about to get, and a
  // click puts it at the caret. With the caret already inside a table the same
  // pill carries the row and column operations under the grid. Neither a mark
  // nor a block property, so a kind of its own; the icon is one the subsetted
  // font already carries (the media library's grid view spells it out).
  { kind: 'table', icon: 'grid_view', title: 'Bảng', state: 'none' },
  { kind: 'sep' },
  { kind: 'cmd', cmd: 'superscript', icon: 'superscript', title: 'Chỉ số trên (x²)', state: 'cmd' },
  { kind: 'cmd', cmd: 'subscript', icon: 'subscript', title: 'Chỉ số dưới (H₂O)', state: 'cmd' },
  { kind: 'sep' },
  { kind: 'menu', menu: 'size', icon: 'format_size', title: 'Cỡ chữ' },
  { kind: 'menu', menu: 'font', icon: 'font_download', title: 'Font chữ' },
  { kind: 'sep' },
  // Alignment. execCommand's justify* commands do work, but they write
  // `style="text-align:…"` and the four classes have to exist anyway for the
  // reading page, so the class is the only representation - one thing to strip,
  // one thing to read back when lighting the button up.
  { kind: 'klass', klass: 'rt-align-left', group: RT_ALIGN_CLASSES, icon: 'format_align_left', title: 'Căn trái', state: 'klass' },
  { kind: 'klass', klass: 'rt-align-center', group: RT_ALIGN_CLASSES, icon: 'format_align_center', title: 'Căn giữa', state: 'klass' },
  { kind: 'klass', klass: 'rt-align-right', group: RT_ALIGN_CLASSES, icon: 'format_align_right', title: 'Căn phải', state: 'klass' },
  { kind: 'klass', klass: 'rt-align-justify', group: RT_ALIGN_CLASSES, icon: 'format_align_justify', title: 'Căn đều hai bên', state: 'klass' },
  { kind: 'sep' },
  // The quotation: a BLOCK wrapper around whatever the caret is in, set on the
  // reading page by .prose-content blockquote in italics between a high opening
  // mark and a low closing one. Sits with the indents because it is the same kind of thing -
  // a block the paragraph goes inside - and apart from them because what it
  // produces is a quotation, not a shift to the right. See rtToggleQuote().
  { kind: 'quote', icon: 'format_quote', title: 'Trích dẫn — đặt cả đoạn giữa hai dấu ngoặc kép, bấm lại để bỏ', state: 'quote' },
  // Terminal/code block: a dark, labelled card for a shell snippet - the
  // "Sao chép" button readers see is not part of this at all, see
  // rtInsertCodeBlock()'s own comment for why. A fresh insertion at the
  // caret, like the image/table buttons beside it, not a toggle on the
  // current block: unlike a quotation, existing prose has nothing worth
  // "becoming" a code block, so there is no unwrap direction to support.
  { kind: 'code', icon: 'terminal', title: 'Chèn khối lệnh (terminal)', state: 'none' },
  // The two indents are different things and both are wanted: this one steps the
  // FIRST line in and leaves the rest on the measure (the Vietnamese prose
  // convention), while the pair below shifts the whole block. `group` is the
  // class itself, so pressing it again takes it back off.
  { kind: 'klass', klass: RT_FIRST_LINE_CLASS, group: [RT_FIRST_LINE_CLASS], icon: 'keyboard_tab', title: 'Lùi dòng đầu tiên của đoạn', state: 'klass' },
  { kind: 'cmd', cmd: 'indent', icon: 'format_indent_increase', title: 'Lùi cả đoạn', state: 'none' },
  { kind: 'cmd', cmd: 'outdent', icon: 'format_indent_decrease', title: 'Giảm lùi cả đoạn', state: 'none' },
  { kind: 'sep' },
  { kind: 'menu', menu: 'lineHeight', icon: 'format_line_spacing', title: 'Giãn dòng' },
  { kind: 'menu', menu: 'space', icon: 'density_medium', title: 'Khoảng cách đoạn' },
  { kind: 'sep' },
  { kind: 'cmd', cmd: 'insertUnorderedList', icon: 'format_list_bulleted', title: 'Danh sách gạch đầu dòng', state: 'cmd' },
  { kind: 'cmd', cmd: 'insertOrderedList', icon: 'format_list_numbered', title: 'Danh sách đánh số', state: 'cmd' },
  { kind: 'sep' },
  { kind: 'cmd', cmd: 'undo', icon: 'undo', title: 'Hoàn tác (Ctrl+Z)', state: 'none' },
  { kind: 'cmd', cmd: 'redo', icon: 'redo', title: 'Làm lại (Ctrl+Y)', state: 'none' },
  { kind: 'clear', icon: 'format_clear', title: 'Xoá định dạng', state: 'none' },
];

// ---- The menus -------------------------------------------------------------
// Each option renders a SPECIMEN of what it sets - "Nét thanh" in Georgia, "Lớn"
// at 1.2em, the leadings over two real lines - which is the whole reason these
// are DOM elements rather than <option>s: an OS-drawn popup can only show words.
// `sample` is the class the specimen text carries (see .rt-menu-sample--* in
// write.html); `value` is what gets applied.
//
// size and font go through execCommand, so their value is a <font> argument;
// lineHeight and space are block classes. The `apply` field says which, so
// openRtMenu() needs no special cases.
const RT_MENUS = {
  size: {
    title: 'Cỡ chữ',
    apply: 'cmd',
    cmd: 'fontSize',
    // The steps are the four .rt-size-* classes api.js maps them to, in the same
    // order; 3 is the paragraph's own size, which is why it is labelled "Vừa"
    // and not "Bình thường" - it is a size, not a reset. `isDefault` says it is
    // also the step a paragraph carrying NO <font size> is already at, which is
    // what openRtMenu() marks when the trigger has no value of its own.
    options: [
      { value: '2', label: 'Nhỏ', sample: 'rt-menu-sample--sm', hint: '85%' },
      { value: '3', label: 'Vừa', sample: 'rt-menu-sample--md', hint: 'Mặc định', isDefault: true },
      { value: '5', label: 'Lớn', sample: 'rt-menu-sample--lg', hint: '135%' },
      { value: '7', label: 'Rất lớn', sample: 'rt-menu-sample--xl', hint: '175%' },
    ],
  },
  font: {
    title: 'Font chữ',
    apply: 'cmd',
    cmd: 'fontName',
    // These three values are the whitelist in api.js RT_FONT_CLASS_BY_FACE and
    // RT_EDITOR_FONT_FACES: a face NOT on that list is treated as a paste and
    // stripped on save, so the picker and the whitelist have to agree.
    options: [
      // isDefault here, not on "Nét thanh" below: a text block's own base
      // CSS (common.css) renders Inter (the site's own UI sans, matching
      // .ed-standfirst) by default now, so this is the option a paragraph
      // carrying no explicit <font face> is already at - see that rule's own
      // comment for why this moved off Newsreader.
      { value: 'Inter, sans-serif', label: 'Mặc định', sample: 'rt-menu-sample--sans', hint: 'Inter', isDefault: true },
      { value: 'Newsreader, Georgia, serif', label: 'Nét thanh', sample: 'rt-menu-sample--serif', hint: 'Newsreader' },
      { value: "'JetBrains Mono', monospace", label: 'Máy đánh chữ', sample: 'rt-menu-sample--mono', hint: 'JetBrains Mono' },
    ],
  },
  lineHeight: {
    title: 'Giãn dòng',
    apply: 'klass',
    group: RT_LH_CLASSES,
    // Two lines of specimen, because one line looks identical at 1.35 and at 2.5.
    options: [
      { value: 'rt-lh-tight', label: '1.35', hint: 'Chật' },
      { value: 'rt-lh-snug', label: '1.6', hint: 'Hơi chật' },
      { value: 'rt-lh-normal', label: '1.7', hint: 'Mặc định', isDefault: true },
      { value: 'rt-lh-relaxed', label: '2.15', hint: 'Thoáng' },
      { value: 'rt-lh-loose', label: '2.5', hint: 'Rất thoáng' },
    ],
  },
  space: {
    title: 'Khoảng cách đoạn',
    apply: 'klass',
    group: RT_SPACE_CLASSES,
    options: [
      { value: 'rt-space-none', label: 'Không', hint: 'Sát nhau' },
      { value: 'rt-space-sm', label: 'Hẹp', hint: '0.5rem dưới' },
      { value: 'rt-space-md', label: 'Vừa', hint: 'Mặc định — 1rem', isDefault: true },
      { value: 'rt-space-lg', label: 'Rộng', hint: '0.75rem trên, 1.5rem dưới' },
    ],
  },
  // The heading block's level. Same listbox, same placement code - the only menu
  // here that is not about a paragraph, which is why its apply is neither 'cmd'
  // nor 'klass' but a level written straight onto the block.
  heading: {
    title: 'Cấp tiêu đề',
    apply: 'level',
    options: [
      { value: '1', label: 'H1', sample: 'rt-menu-sample--xl', hint: 'Tiêu đề chính, rất lớn' },
      { value: '2', label: 'H2', sample: 'rt-menu-sample--lg', hint: 'Tiêu đề mục, lớn' },
      { value: '3', label: 'H3', sample: 'rt-menu-sample--md', hint: 'Tiêu đề nhỏ, vừa' },
    ],
  },
  // The "Bố cục ảnh" block's kind. Was a native <select>, whose open list the
  // OS draws (white, unstyleable, and not dark on the dark themes) - the same
  // reason every other picker in this editor is a listbox. Like `heading`, a
  // property of the BLOCK: apply 'layout' writes it to the model. The options
  // are IMAGE_LAYOUTS (js/api.js), with how many pictures each takes as the hint.
  layoutKind: {
    title: 'Kiểu bố cục',
    apply: 'layout',
    options: IMAGE_LAYOUTS.map((l) => ({
      value: l.id,
      label: l.label,
      hint: `${l.max ? `${l.count}–${l.max} ảnh` : `${l.count} ảnh`}${l.text ? ' · kèm chữ' : ''}`,
    })),
  },
  // A heading INSIDE a paragraph block's own rich text - not the dedicated
  // "heading" block above (a separate block type, its own plain-text field, no
  // rich formatting). This is for turning a line the author is already writing
  // prose in into a section title without leaving the paragraph to add a whole
  // new block. `apply: 'cmd'` with execCommand('formatBlock', ...) is the exact
  // mechanism the size/font menus above already use - no new branch needed in
  // applyRtMenuValue(). h1 is deliberately not offered here: that level is the
  // dedicated heading block's own H1 option (and the post's own title above the
  // editor), not something prose should produce a second one of.
  //
  // The one risk 'formatBlock' carries - a selection spanning several existing
  // blocks (several <p>, a pasted <table>) gets wrapped in ONE new element
  // instead of converting just the first, in some browsers - is not guarded
  // against here. server/sanitize-html.js's own fix for exactly that shape (a
  // heading that had swallowed a whole paragraph and table as its textContent,
  // see its CLOSES_HEADING comment) is the backstop: whatever this produces,
  // the save pipeline splits a heading back to a single line before it ever
  // reaches a reader.
  headingFormat: {
    title: 'Định dạng',
    apply: 'cmd',
    cmd: 'formatBlock',
    options: [
      { value: 'p', label: 'Đoạn văn thường', sample: 'rt-menu-sample--md', hint: 'Văn bản bình thường', isDefault: true },
      { value: 'h2', label: 'Tiêu đề 2', sample: 'rt-menu-sample--lg', hint: 'Tiêu đề mục, lớn' },
      { value: 'h3', label: 'Tiêu đề 3', sample: 'rt-menu-sample--md', hint: 'Tiêu đề nhỏ, vừa' },
    ],
  },
  // Chèn ảnh. Neither a mark nor a block property: `apply: 'action'` says the
  // value names something to DO at the caret, and applyRtMenuValue() hands it to
  // rtInsertImage(). Nothing is ever "selected" here, so the trigger keeps its
  // own name and never tints - which is what rtTriggerValue() returns '' for.
  // The options are the three ways to get a picture, and each carries an icon:
  // this is the one menu whose choices are destinations rather than specimens, so
  // there is nothing to set the label in and the icon does the distinguishing.
  image: {
    title: 'Chèn ảnh',
    apply: 'action',
    options: [
      { value: 'upload', icon: 'cloud_upload', label: 'Tải ảnh lên', hint: 'Từ máy tính — ảnh được lưu luôn vào thư viện' },
      { value: 'library', icon: 'perm_media', label: 'Từ thư viện', hint: 'Dùng lại ảnh đã tải lên, không gửi lại file' },
      { value: 'url', icon: 'link', label: 'Từ đường dẫn', hint: 'Ảnh đã có sẵn ở nơi khác trên mạng' },
    ],
  },
};

// The label the trigger shows: the option in force, or the menu's own name when
// nothing has been chosen. Looked up by value, so "Lớn" appears on the pill the
// moment the caret enters a run that carries it.
function rtMenuLabel(menuName, value) {
  const menu = RT_MENUS[menuName];
  const found = value ? menu.options.find((o) => o.value === value) : null;
  return found ? found.label : menu.title;
}

// role="toolbar" is a promise about the keyboard: ONE tab stop for the whole
// group, and the arrow keys to move inside it. The tabindex below is half of
// that promise (the first control is the stop, the rest are reachable only by
// script) and the keydown handler further down is the other half. Without both,
// a screen-reader user would arrow into nothing - and all 25 controls would sit
// between the text and whatever follows it as 25 separate Tab stops.
//
// No data-key on any of them. There is ONE toolbar for the whole page, docked to
// the bottom of the viewport, and it acts on whichever editor the caret is in -
// activeRtEditor(). The toolbar used to be rendered inside every paragraph block,
// which put a copy of all 25 controls in the DOM per block and pushed the text
// down the page; on a long post that meant scrolling back up to reach the
// formatting for the paragraph you were already inside.
function rtToolbarHtml() {
  let first = true;
  return RT_TOOLBAR.map((item) => {
    if (item.kind === 'sep') return '<span class="rt-sep" aria-hidden="true"></span>';
    const tabindex = ` tabindex="${first ? 0 : -1}"`;
    first = false;

    const icon = item.icon ? `<span class="material-symbols-outlined" aria-hidden="true">${item.icon}</span>` : '';
    // Everything the click handler needs, so it never has to search the table.
    const data = [
      item.cmd ? `data-cmd="${item.cmd}"` : '',
      item.value ? `data-value="${escapeHtml(item.value)}"` : '',
      item.klass ? `data-class="${item.klass}"` : '',
      item.group ? `data-group="${item.group.join(' ')}"` : '',
      item.menu ? `data-menu="${item.menu}"` : '',
      item.kind === 'link' ? 'data-link="1"' : '',
      item.kind === 'table' ? 'data-table="1"' : '',
      item.kind === 'quote' ? 'data-quote-block="1"' : '',
      item.kind === 'quoteInline' ? 'data-quote-inline="1"' : '',
      item.kind === 'code' ? 'data-code-block="1"' : '',
      `data-state="${item.state || 'none'}"`,
    ]
      .filter(Boolean)
      .join(' ');

    if (item.kind === 'menu') {
      // aria-haspopup + aria-expanded, and the label is in aria-label rather than
      // in the visible text: the visible text is the VALUE ("Lớn"), which on its
      // own does not say what it is the size of.
      return `<button type="button" class="rt-select rt-menu-trigger" ${data}${tabindex}
        aria-haspopup="listbox" aria-expanded="false" aria-label="${escapeHtml(item.title)}" title="${escapeHtml(item.title)}">
        ${icon}<span class="rt-select-value">${escapeHtml(RT_MENUS[item.menu].title)}</span>
      </button>`;
    }

    if (item.kind === 'table') {
      // The same pill as a menu trigger, because it opens the same kind of
      // floating panel - but a dialog rather than a listbox: what is inside is
      // a grid to sweep the pointer over, not a list of options. The visible
      // text is the pill's own name ("Bảng"): unlike "Cỡ chữ" there is no value
      // in force for it to show.
      return `<button type="button" class="rt-select rt-table-trigger" ${data}${tabindex}
        aria-haspopup="dialog" aria-expanded="false" aria-label="${escapeHtml(item.title)}" title="${escapeHtml(item.title)}">
        ${icon}<span class="rt-select-value">${escapeHtml(item.title)}</span>
      </button>`;
    }

    // A letter button labels itself (B / I / U); an icon button cannot, so it
    // carries an aria-label as well as the tooltip.
    const cls = ['rt-btn', item.btnClass, item.kind === 'clear' ? 'rt-clear-btn' : ''].filter(Boolean).join(' ');
    const pressed = item.state && item.state !== 'none' ? ' aria-pressed="false"' : '';
    const label = item.label ? escapeHtml(item.label) : '';
    const aria = item.label ? '' : ` aria-label="${escapeHtml(item.title)}"`;
    return `<button type="button" class="${cls}" ${data}${tabindex}${pressed}${aria} title="${escapeHtml(item.title)}">${icon}${label}</button>`;
  }).join('');
}

// When an image (or embed) block sits between two paragraph blocks whose rich
// text is otherwise one numbered list - split apart only so a picture could
// go in the middle of it, e.g. between item 1 and item 2 - the second half's
// own <ol> restarts at 1 by default, because as far as the browser knows it
// IS a new, separate list. This walks the blocks in order and gives the
// second half the `start` that continues the first instead. Recomputed on
// every renderBlocks() call (every add/move/delete), which is also every
// point the shape this looks for could have changed.
//
// Scoped deliberately narrow: only a paragraph block's list continuing across
// a run of image/embed blocks, never across a heading or another paragraph
// with its own text - two separate, deliberately-restarted lists sitting next
// to each other with real prose or a heading between them are left alone. A
// list that happens to sit right after an image/embed run purely by
// coincidence, with no earlier list at all, is also left alone: pendingNext
// is null until an <ol> has actually been seen, so there is nothing to
// continue from yet.
function rtRenumberContinuedLists(list) {
  let pendingNext = null; // next number a following list should continue from, or null
  let sawGap = false; // at least one image/embed block skipped since the last list
  for (const b of list) {
    if (b.type === 'image' || b.type === 'embed') {
      if (pendingNext !== null) sawGap = true; // transparent, but no longer adjacent
      continue;
    }
    if (b.type !== 'paragraph' || b.html === undefined) {
      pendingNext = null;
      sawGap = false;
      continue;
    }
    const tpl = document.createElement('template');
    tpl.innerHTML = b.html;
    const kids = [...tpl.content.childNodes].filter(
      (n) => n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim())
    );
    const first = kids[0];
    const last = kids[kids.length - 1];
    let changed = false;
    // Only across an actual gap (sawGap): two list blocks sitting directly
    // back to back, with nothing - not even one image - between them, are
    // left alone as two deliberately separate lists. Continuation only
    // applies to the shape the image insert actually produces: a list split
    // BY something landing in the middle of it.
    if (pendingNext !== null && sawGap && first && first.nodeType === 1 && first.tagName === 'OL') {
      if ((first.getAttribute('start') || '1') !== String(pendingNext)) {
        if (pendingNext === 1) first.removeAttribute('start');
        else first.setAttribute('start', String(pendingNext));
        changed = true;
      }
    }
    if (last && last.nodeType === 1 && last.tagName === 'OL') {
      const startAttr = Number(last.getAttribute('start')) || 1;
      const itemCount = last.querySelectorAll(':scope > li').length;
      pendingNext = startAttr + itemCount;
      sawGap = false;
    } else {
      pendingNext = null;
      sawGap = false;
    }
    if (changed) b.html = tpl.innerHTML;
  }
}

function renderBlocks() {
  // Recomputed before every render, not just after an image/embed insert or
  // move: a render also follows a delete, and removing the block that used to
  // sit between two list halves is exactly when they stop being "continued"
  // and the second half should fall back to starting at 1 again.
  rtRenumberContinuedLists(blocks);
  // Every .rt-editor is about to be replaced, so the picture the image panel is
  // rimmed around is about to be detached from the document. Let the panel go
  // first rather than leaving it sized to a box that no longer exists.
  closeRtImgPanel();
  const container = document.getElementById('blocks-container');
  const emptyHint = document.getElementById('blocks-empty-hint');
  emptyHint.classList.toggle('hidden', blocks.length > 0);

  // The header row's other half, now that the four add-buttons have moved to the
  // rail on the left: how long the article already is. On a post of forty blocks
  // that is the difference between "just started" and "nearly done" without
  // scrolling to find out. The word count and read time are the SAME estimate
  // post.js shows a reader (estimateReadMinutes() there: words/200, rounded up
  // to at least one minute) - a real, computed-from-what-is-actually-here number,
  // not the reference mockup's static "1,420 từ". Recomputed whenever the block
  // list itself changes (add/remove/move) rather than on every keystroke inside
  // one block - the same cadence this line already used before word count
  // existed, so a fast typist never pays for a per-key totals pass over every
  // block's content.
  const countEl = document.getElementById('blocks-count');
  if (countEl) {
    if (blocks.length) {
      const totalWords = blocks.reduce((sum, b) => {
        const text =
          b.type === 'paragraph' || b.type === 'layout' ? String(b.html || '').replace(/<[^>]*>/g, ' ') : String(b.text || '');
        const words = text.trim() ? text.trim().split(/\s+/).length : 0;
        return sum + words;
      }, 0);
      const readMin = Math.max(1, Math.round(totalWords / 200));
      countEl.textContent = `${blocks.length} khối · ${totalWords} từ · ~${readMin} phút đọc`;
    } else {
      countEl.textContent = '';
    }
  }

  container.innerHTML = blocks
    .map((b, i) => {
      const controls = `
      <div class="rt-block-actions">
        <button type="button" class="rt-icon-btn block-move-up" data-key="${b.key}" ${i === 0 ? 'disabled' : ''} aria-label="Di chuyển lên" title="Lên"><span class="material-symbols-outlined" aria-hidden="true">arrow_upward</span></button>
        <button type="button" class="rt-icon-btn block-move-down" data-key="${b.key}" ${i === blocks.length - 1 ? 'disabled' : ''} aria-label="Di chuyển xuống" title="Xuống"><span class="material-symbols-outlined" aria-hidden="true">arrow_downward</span></button>
        <button type="button" class="rt-icon-btn rt-icon-btn--danger block-remove" data-key="${b.key}" aria-label="Xoá khối" title="Xoá khối"><span class="material-symbols-outlined" aria-hidden="true">delete</span></button>
      </div>`;

      if (b.type === 'heading') {
        // A stored block from an early version can carry no level at all, and an
        // interpolated `undefined` would reach the markup as both "Hundefined"
        // and .rt-field--hundefined - a class with no rule, so the input would
        // lose its size entirely.
        const level = rtHeadingLevel(b);
        return `
        <div class="rt-block" data-block-key="${b.key}">
          <div class="rt-block-head">
            <span class="rt-block-kind"><span class="material-symbols-outlined" aria-hidden="true">title</span>Tiêu đề</span>
            ${controls}
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button type="button" class="rt-select rt-menu-trigger" data-key="${b.key}" data-menu="heading"
              aria-haspopup="listbox" aria-expanded="false" aria-label="Cấp tiêu đề" title="Cấp tiêu đề">
              <span class="material-symbols-outlined" aria-hidden="true">title</span><span class="rt-select-value">H${level}</span>
            </button>
            <input class="rt-field rt-field--h${level} block-heading-text flex-grow" data-key="${b.key}" placeholder="Nhập tiêu đề..." aria-label="Nội dung tiêu đề" value="${escapeHtml(b.text)}">
          </div>
        </div>`;
      }

      if (b.type === 'image') {
        return `
        <div class="rt-block" data-block-key="${b.key}">
          <div class="rt-block-head">
            <span class="rt-block-kind"><span class="material-symbols-outlined" aria-hidden="true">image</span>Ảnh</span>
            ${controls}
          </div>
          ${
            b.url
              ? `<img src="${escapeHtml(b.url)}" class="rt-image-preview" alt="">`
              : `<div class="rt-image-empty"><span class="material-symbols-outlined" aria-hidden="true">image</span>Chưa có ảnh</div>`
          }
          <div class="flex flex-wrap items-center gap-2 mb-2">
            <label class="rt-upload">
              <span class="material-symbols-outlined" aria-hidden="true">cloud_upload</span>Tải ảnh lên
              <input type="file" class="block-image-file hidden" data-key="${b.key}" accept="image/png,image/jpeg,image/webp,image/gif">
            </label>
            <!-- Reuse an image already uploaded, rather than sending the same file
                 again. Opens the picker modal shared with the admin panel. -->
            <button type="button" class="rt-upload block-image-library" data-key="${b.key}">
              <span class="material-symbols-outlined" aria-hidden="true">perm_media</span>Thư viện
            </button>
            <input class="rt-field block-image-url flex-grow" data-key="${b.key}" placeholder="hoặc dán URL ảnh..." aria-label="URL ảnh" value="${escapeHtml(b.url)}">
          </div>
          <input class="rt-field block-image-caption" data-key="${b.key}" placeholder="Chú thích ảnh (không bắt buộc)" aria-label="Chú thích ảnh" value="${escapeHtml(b.caption)}">
          <p class="rt-hint block-image-status hidden" data-key="${b.key}"></p>
        </div>`;
      }

      if (b.type === 'layout') return layoutBlockEditorHtml(b, controls);

      if (b.type === 'embed') {
        // A resolved embed shows the real frame, so the author sees what a reader
        // will. Before that it is a hint listing what can be pasted - the set of
        // providers is not guessable, and a bare "invalid URL" after the fact is a
        // worse way to learn it.
        const preview = b.src
          ? `<div class="rt-embed-frame" style="${b.height ? `height:${Number(b.height)}px` : `aspect-ratio:${b.ratio || '16 / 9'}`}">
               <iframe src="${escapeHtml(b.src)}" title="${escapeHtml(b.title || 'Nội dung nhúng')}"
                 loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
             </div>`
          : `<div class="rt-embed-empty">
               <span class="material-symbols-outlined" aria-hidden="true">play_circle</span>
               <span>Dán link YouTube, Vimeo, TikTok, Spotify, Facebook, Google Drive hoặc Google Maps</span>
             </div>`;
        return `
        <div class="rt-block" data-block-key="${b.key}">
          <div class="rt-block-head">
            <span class="rt-block-kind"><span class="material-symbols-outlined" aria-hidden="true">play_circle</span>Nhúng${
              b.provider ? ` · ${escapeHtml(b.provider)}` : ''
            }</span>
            ${controls}
          </div>
          ${preview}
          <div class="flex flex-wrap items-center gap-2 mb-2">
            <input class="rt-field block-embed-url flex-grow" data-key="${b.key}" placeholder="https://www.youtube.com/watch?v=..." aria-label="Đường dẫn cần nhúng" value="${escapeHtml(b.url)}">
            <button type="button" class="rt-upload block-embed-load" data-key="${b.key}">
              <span class="material-symbols-outlined" aria-hidden="true">link</span>Nhúng
            </button>
          </div>
          <input class="rt-field block-embed-caption" data-key="${b.key}" placeholder="Chú thích (không bắt buộc)" aria-label="Chú thích nội dung nhúng" value="${escapeHtml(b.caption)}">
          <p class="rt-hint block-embed-status hidden" data-key="${b.key}"></p>
        </div>`;
      }

      // paragraph — the rich-text block. The toolbar's character-level buttons
      // apply to the SELECTED run; the block-level ones (alignment, indent,
      // leading, spacing) apply to the paragraph the caret is in.
      // .is-empty is what shows the placeholder: :empty stops matching the moment
      // the browser drops a stray <br> into an emptied contenteditable, so the
      // hint would otherwise vanish for good after the first backspace.
      const empty = b.html && b.html.trim() ? '' : ' is-empty';
      return `
      <div class="rt-block" data-block-key="${b.key}">
        <div class="rt-block-head">
          <span class="rt-block-kind"><span class="material-symbols-outlined" aria-hidden="true">format_align_left</span>Văn bản</span>
          ${controls}
        </div>
        <div class="rt-editor rt-surface block-paragraph-editor${empty}" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Nội dung đoạn văn" data-key="${b.key}" data-placeholder="Nhập đoạn văn... bôi đen một đoạn để định dạng riêng đoạn đó">${b.html || ''}</div>
        <div class="rt-footer">
          <p class="rt-hint">Đặt con trỏ vào đây để hiện thanh định dạng ở đáy màn hình. Bôi đen một đoạn chữ rồi bấm <strong>B</strong>, <strong>I</strong> hay cỡ chữ để chỉ áp dụng cho đúng đoạn đó; các nút căn lề, lùi dòng đầu, giãn dòng, khoảng cách và <strong>Trích dẫn</strong> áp dụng cho cả đoạn chứa con trỏ — riêng <strong>Trích dẫn</strong> đặt cả đoạn giữa hai dấu ngoặc kép, bấm lần nữa để bỏ; còn <strong>“„</strong> thì đặt ngoặc kép quanh đúng phần chữ bôi đen. Ảnh thì dán thẳng (<strong>Ctrl+V</strong>) hoặc bấm nút <strong>Chèn ảnh</strong> — ảnh nằm đúng chỗ con trỏ, giữa đoạn văn.</p>
          <p class="rt-hint">Hỗ trợ Markdown: gõ <code>##</code> + cách → tiêu đề, <code>-</code> hoặc <code>1.</code> + cách → danh sách, <code>&gt;</code> + cách → trích dẫn, <code>&#96;&#96;&#96;</code> + Enter → khối lệnh, <code>---</code> + Enter → đường kẻ; <code>**đậm**</code> <code>*nghiêng*</code> <code>&#96;code&#96;</code> <code>~~gạch~~</code>. Dán văn bản Markdown cũng tự chuyển thành định dạng.</p>
          <p class="rt-hint rt-count" data-key="${b.key}">${rtCountFromHtml(b.html)}</p>
        </div>
        <!-- Where an upload reports itself: the chip in the text says "đang tải",
             this says why one did not arrive. Outside .rt-footer, which is a row of
             the hint and the count and has no room for a third thing. -->
        <p class="rt-hint block-paragraph-status hidden" data-key="${b.key}"></p>
      </div>`;
    })
    .join('');

  // Sweeps every editor for a picture that cannot survive a save: a data: image the
  // browser's own paste put there gets its bytes recovered and uploaded, and an
  // <img> with a src the sanitizer already blanked - which is what a draft saved
  // before that adoption existed holds - is taken out rather than left as an
  // invisible hole the author counts as a picture. Runs here, on every render,
  // because render is the one moment every editor in the post is guaranteed to have
  // just been rebuilt from the model and can be corrected in one pass.
  for (const editor of container.querySelectorAll('.rt-editor')) rtAdoptStrayImages(editor);

  syncRtToolbars();
}

// Word and character count. Counted off text, never markup, so a formatting tag
// is not a word; the split is on any whitespace run, which is what makes it right
// for Vietnamese - words are space-separated and a syllable is not a word.
// \u00a0 is in the class as well as \s because a contenteditable inserts a
// NON-BREAKING space when you type two in a row, and JavaScript's \s does not
// match one: two words would otherwise be counted as one.
function rtCountLabel(text) {
  const clean = String(text ?? '').replace(/[\s\u00a0]+/g, ' ').trim();
  const words = clean ? clean.split(' ').length : 0;
  return `${words} từ · ${clean.length} ký tự`;
}

// At first render the block is still just stored HTML with no element to read, so
// that one string is parsed. Every later update comes from syncEditorToBlock(),
// which has the live editor and reads its textContent directly - no parse per
// keystroke.
function rtCountFromHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html ?? '');
  return rtCountLabel(tpl.content.textContent);
}

// ---- "Bố cục ảnh" block ------------------------------------------------------
// A picker for the layout, one slot per picture the layout uses (masonry: the
// pictures so far plus an empty slot, up to its max), each slot with upload /
// library / URL and an optional alt text (the caption stands in when it is
// empty - renderLayoutBlockHtml()), the caption, the rich-text editor for
// the two layouts that sit beside prose, and a live preview drawn by the very
// renderer the article page uses (renderLayoutBlockHtml(), js/api.js).
function layoutSlotCount(b) {
  const def = imageLayoutDef(b.layout);
  if (!def.max) return def.count;
  const filled = (b.images || []).filter((im) => im && im.url).length;
  return Math.min(def.max, Math.max(def.count, filled + 1));
}

function layoutSlotHtml(b, i) {
  const im = (b.images || [])[i] || {};
  const k = b.key;
  return `
    <div class="rt-lay-slot">
      ${
        im.url
          ? `<img src="${escapeHtml(im.url)}" class="rt-lay-thumb" alt="">`
          : `<div class="rt-lay-thumb rt-lay-thumb--empty"><span class="material-symbols-outlined" aria-hidden="true">image</span>Ảnh ${i + 1}</div>`
      }
      <div class="rt-lay-slot-actions">
        <label class="rt-upload" title="Tải ảnh lên">
          <span class="material-symbols-outlined" aria-hidden="true">cloud_upload</span>Tải lên
          <input type="file" class="block-layout-file hidden" data-key="${k}" data-idx="${i}" accept="image/png,image/jpeg,image/webp,image/gif">
        </label>
        <button type="button" class="rt-upload block-layout-library" data-key="${k}" data-idx="${i}" title="Chọn từ thư viện">
          <span class="material-symbols-outlined" aria-hidden="true">perm_media</span>Thư viện
        </button>
        ${
          im.url
            ? `<button type="button" class="rt-icon-btn rt-icon-btn--danger block-layout-remove" data-key="${k}" data-idx="${i}" aria-label="Bỏ ảnh ${i + 1}" title="Bỏ ảnh"><span class="material-symbols-outlined" aria-hidden="true">close</span></button>`
            : ''
        }
      </div>
      <input class="rt-field block-layout-url" data-key="${k}" data-idx="${i}" placeholder="hoặc dán URL ảnh..." aria-label="URL ảnh ${i + 1}" value="${escapeHtml(im.url || '')}">
      <input class="rt-field block-layout-alt" data-key="${k}" data-idx="${i}" placeholder="Mô tả ảnh (không bắt buộc)" aria-label="Mô tả ảnh ${i + 1}" value="${escapeHtml(im.alt || '')}">
    </div>`;
}

function layoutPreviewHtml(b) {
  const def = imageLayoutDef(b.layout);
  if (!imageLayoutImages(b).length) return '';
  // The text is the placeholder, not the author's own words: they are already
  // in the editor right above, and seeing them twice reads as a duplicate.
  const html = def.text
    ? '<p class="rt-lay-placeholder">Phần chữ bạn soạn ở trên sẽ nằm ở đây, chảy quanh hoặc cạnh ảnh đúng như khi đăng.</p>'.repeat(2)
    : '';
  return `<div class="rt-lay-preview">
      <p class="rt-hint">Xem trước</p>
      <div class="prose-content">${renderLayoutBlockHtml({ ...b, html })}</div>
    </div>`;
}

function layoutBlockEditorHtml(b, controls) {
  const def = imageLayoutDef(b.layout);
  const slots = Array.from({ length: layoutSlotCount(b) }, (_, i) => layoutSlotHtml(b, i)).join('');
  const extra = (b.images || []).filter((im) => im && im.url).length - (def.max || def.count);
  const empty = b.html && b.html.trim() ? '' : ' is-empty';
  return `
    <div class="rt-block" data-block-key="${b.key}">
      <div class="rt-block-head">
        <span class="rt-block-kind"><span class="material-symbols-outlined" aria-hidden="true">photo_library</span>Bố cục ảnh</span>
        ${controls}
      </div>
      <button type="button" class="rt-select rt-menu-trigger rt-layout-trigger mb-3" data-key="${b.key}" data-menu="layoutKind" data-value="${def.id}"
        aria-haspopup="listbox" aria-expanded="false" aria-label="Kiểu bố cục" title="Kiểu bố cục">
        <span class="material-symbols-outlined" aria-hidden="true">photo_library</span><span class="rt-select-value">${escapeHtml(def.label)}</span>
      </button>
      <div class="rt-lay-slots${def.count > 1 || def.max ? ' rt-lay-slots--multi' : ''}">${slots}</div>
      ${
        def.max
          ? `<button type="button" class="rt-upload block-layout-add mt-2" data-key="${b.key}"><span class="material-symbols-outlined" aria-hidden="true">cloud_upload</span>Thêm nhiều ảnh</button>`
          : ''
      }
      ${extra > 0 ? `<p class="rt-hint">Kiểu này dùng ${def.max || def.count} ảnh đầu; ${extra} ảnh còn lại được giữ nếu bạn đổi sang kiểu khác.</p>` : ''}
      ${
        def.text
          ? `<div class="rt-editor rt-surface block-paragraph-editor mt-3${empty}" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Chữ đi kèm ảnh" data-key="${b.key}" data-placeholder="Nhập đoạn chữ đi kèm ảnh...">${b.html || ''}</div>`
          : ''
      }
      <input class="rt-field block-layout-caption mt-3" data-key="${b.key}" placeholder="Chú thích (không bắt buộc)" aria-label="Chú thích bố cục ảnh" value="${escapeHtml(b.caption || '')}">
      <p class="rt-hint block-layout-status hidden" data-key="${b.key}"></p>
      ${layoutPreviewHtml(b)}
    </div>`;
}

// The slot's picture, creating the entry (and any gap before it) on demand.
function layoutImageAt(block, idx) {
  if (!Array.isArray(block.images)) block.images = [];
  while (block.images.length <= idx) block.images.push({ url: '', alt: '' });
  return block.images[idx];
}

// Masonry grows by appending; a fixed layout fills its slot. The images array is
// compacted of empty entries so "Ảnh 3" never refers to a hole.
function layoutCompact(block) {
  block.images = (block.images || []).filter((im) => im && (im.url || im.alt));
}

function layoutStatus(key, message, isError) {
  const el = document.querySelector(`.block-layout-status[data-key="${key}"]`);
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('hidden', !message);
  el.classList.toggle('text-error', !!isError);
}

async function uploadLayoutImage(key, idx, file) {
  layoutStatus(key, 'Đang tải ảnh lên...');
  try {
    const { url } = await API.uploadImage(file, {
      endpoint: '/media',
      onProgress: (ratio, loaded, total) =>
        layoutStatus(key, `Đang tải lên ${Math.round(ratio * 100)}% (${formatUploadBytes(loaded)} / ${formatUploadBytes(total)})`),
    });
    const block = findBlock(key);
    if (block) {
      const im = layoutImageAt(block, idx);
      im.url = url;
      delete im.width;
      delete im.height;
    }
    renderBlocks();
  } catch (err) {
    layoutStatus(key, err.message, true);
  }
}

function findBlock(key) {
  return blocks.find((b) => b.key === Number(key));
}

// H2 is the default for anything that is not 1 or 3 - the same fallback
// renderContentBlocksHtml() in js/api.js applies when publishing.
function rtHeadingLevel(block) {
  const n = Number(block && block.level);
  return n === 1 || n === 3 ? n : 2;
}

// Toolbar: add new block
document.querySelectorAll('.add-block-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    blocks.push(newBlock(btn.dataset.type));
    renderBlocks();
  });
});

// ---- Rich text: the selection ----------------------------------------------
// document.execCommand applies to the browser's CURRENT selection, so formatting
// only ever affects the highlighted run inside a .rt-editor - not the whole
// block. The last selection made inside an editor is tracked because opening a
// menu moves focus into it, which collapses that selection: the menu restores it
// before applying anything.
let savedRtSelection = null;

function saveRtSelection(editor) {
  const sel = window.getSelection();
  if (sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
    savedRtSelection = { range: sel.getRangeAt(0).cloneRange(), editor };
  }
}

function restoreRtSelection() {
  if (!savedRtSelection) return null;
  // A re-render (adding a block, moving one, uploading an image) replaces every
  // editor element, and a Range pointing into a detached node silently applies
  // formatting to nothing. Cheaper to check than to debug.
  if (!document.contains(savedRtSelection.editor)) {
    savedRtSelection = null;
    return null;
  }
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(savedRtSelection.range);
  savedRtSelection.editor.focus();
  return savedRtSelection.editor;
}

// The editor the caret is in right now, whether or not it still has focus.
function activeRtEditor() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const node = sel.anchorNode;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    const editor = el && el.closest('.rt-editor');
    if (editor) return editor;
  }
  return savedRtSelection && document.contains(savedRtSelection.editor) ? savedRtSelection.editor : null;
}

function syncEditorToBlock(editor) {
  const block = findBlock(editor.dataset.key);
  // \u200B: the caret-parking character the Markdown inline shortcuts leave
  // after a mark - never stored.
  if (block) block.html = editor.innerHTML.replace(/\u200B/g, '');
  editor.classList.toggle('is-empty', !editor.textContent.trim() && !editor.querySelector('img'));
  const counter = document.querySelector(`.rt-count[data-key="${editor.dataset.key}"]`);
  if (counter) counter.textContent = rtCountLabel(editor.textContent);
}

// ---- Block-level formatting -------------------------------------------------
// The paragraph the caret is in. execCommand's own commands work on whatever
// block element they find, but there may not BE one: a fresh contenteditable
// holds bare text nodes directly, and a class has to go somewhere. So the caret's
// block is found, and if it turns out to be the editor itself, formatBlock wraps
// the text in a <p> first.
// The editor itself is not in the list and is never a target: a class landing on
// .rt-editor would style every paragraph in the block at once.
// BLOCKQUOTE is in it, and deliberately: an indented paragraph typed with no
// <p> of its own IS the blockquote execCommand('indent') created, so excluding it
// would leave that paragraph with nowhere to carry an alignment. api.js retags
// the wrapper to <div class="rt-indent"> on save and keeps its class list, so the
// alignment survives the trip.
const RT_BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'FIGCAPTION', 'TD', 'TH']);

// `create` is the whole reason this takes an option: syncRtToolbars() calls it on
// every selectionchange just to decide whether a button looks pressed, and a
// read that wrapped the line in a <p> would rewrite the author's markup every
// time the caret moved.
function rtCurrentBlock(editor, { create = false } = {}) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType !== 1) node = node.parentElement;
  while (node && node !== editor) {
    if (RT_BLOCK_TAGS.has(node.tagName)) return node;
    node = node.parentElement;
  }
  if (!node || !create) return null;
  // Nothing between the caret and the editor: a fresh contenteditable holds bare
  // text nodes, and a class has to go somewhere. formatBlock is the one
  // execCommand that creates a block element, and every engine implements it.
  document.execCommand('formatBlock', false, 'p');
  let created = window.getSelection().getRangeAt(0).startContainer;
  if (created.nodeType !== 1) created = created.parentElement;
  return created.closest('p') || (created === editor ? null : created);
}

// Every block the selection TOUCHES, not just the one the caret started in, so
// selecting three paragraphs and pressing "căn giữa" centres all three - which is
// what Word does and what the button implies.
function rtSelectedBlocks(editor, { create = true } = {}) {
  const sel = window.getSelection();
  const start = rtCurrentBlock(editor, { create });
  if (!start) return [];
  if (!sel.rangeCount || sel.isCollapsed) return [start];
  const range = sel.getRangeAt(0);
  const all = [...editor.querySelectorAll('*')].filter((el) => RT_BLOCK_TAGS.has(el.tagName));
  const touched = all.filter((el) => range.intersectsNode(el));
  // A nested block (a <li> inside its <ol>, a <p> inside an indent <div>) would
  // otherwise be styled twice - once directly and once through its ancestor.
  // Walking each element's OWN ancestor chain against a Set is O(touched * depth):
  // the touched.some(other.contains(el)) this replaced was O(touched^2), which on
  // a paragraph carrying a big pasted table or list (hundreds of <td>/<li>) turned
  // every selection change into hundreds of thousands of DOM comparisons - and
  // this runs once per klass button/trigger synced (see rtSelectedBlocksCached
  // below), so the quadratic cost was being paid several times over per keystroke.
  const touchedSet = new Set(touched);
  const inner = touched.filter((el) => {
    let p = el.parentElement;
    while (p && p !== editor) {
      if (touchedSet.has(p)) return false;
      p = p.parentElement;
    }
    return true;
  });
  return inner.length ? inner : [start];
}

// syncRtToolbars() reads the caret's selected blocks once per klass button (5)
// plus once per klass-apply trigger (lineHeight, space) - up to 7 calls per
// sync, all with the same editor and the same unchanged selection (nothing
// between them yields to the event loop). Recomputing rtSelectedBlocks() for
// each was the same read repeated 7 times, on top of its own cost - cached here
// per sync instead. rtCachedSyncPass is bumped once at the top of every
// syncRtToolbars() call so a stale cache from the PREVIOUS call can never be
// mistaken for this one's.
let rtCachedSyncPass = 0;
let rtSelectedBlocksMemo = null; // { pass, editor, result }
function rtSelectedBlocksCached(editor) {
  if (rtSelectedBlocksMemo && rtSelectedBlocksMemo.pass === rtCachedSyncPass && rtSelectedBlocksMemo.editor === editor) {
    return rtSelectedBlocksMemo.result;
  }
  const result = rtSelectedBlocks(editor, { create: false });
  rtSelectedBlocksMemo = { pass: rtCachedSyncPass, editor, result };
  return result;
}

// Applies one of the block classes, replacing whatever else in its group was
// there. A `group` of just the class itself makes the press a TOGGLE, which is
// what the first-line indent needs.
//
// A plain el.classList write here is invisible to the browser's own undo
// stack - unlike everything else this toolbar does, which is execCommand
// specifically so Ctrl+Z can take it back (see rtInsertAtTarget()'s own
// comment on this). That made every alignment, first-line-indent, line-height
// and paragraph-spacing press permanent: pressing "căn giữa" by accident, or
// twice, had no way back short of retyping the paragraph.
// The single-target case - the caret sitting in one paragraph, which is what
// a press without a multi-paragraph selection always is - is rewritten
// through execCommand('insertHTML') instead: select the whole block as a
// node, hand back its own (now reclassed) outerHTML, and the browser records
// the swap as one undoable step, the same trick used for a pasted picture or
// an inserted table. A selection spanning SEVERAL paragraphs falls back to
// the direct class write below - replacing a multi-paragraph range through
// one insertHTML call would mean rebuilding the exact HTML of everything
// between the first and last target by hand, and a mistake there risks losing
// content the classList write cannot.
function rtApplyBlockClass(editor, klass, group) {
  const targets = rtSelectedBlocks(editor);
  if (!targets.length) return;
  // Off only if EVERY selected block already has it - otherwise the press brings
  // the odd one out into line, rather than clearing the ones that agreed.
  const allOn = targets.every((el) => el.classList.contains(klass));

  if (targets.length === 1) {
    const el = targets[0];
    for (const other of group) el.classList.remove(other);
    if (!allOn) el.classList.add(klass);
    if (!el.className) el.removeAttribute('class');
    const range = document.createRange();
    range.selectNode(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    if (document.execCommand('insertHTML', false, el.outerHTML)) return;
    // Some engine refused the command - the class is already applied above,
    // so the press still took effect, just without landing on undo.
    return;
  }

  for (const el of targets) {
    for (const other of group) el.classList.remove(other);
    if (!allOn) el.classList.add(klass);
    if (!el.className) el.removeAttribute('class');
  }
}

// "Xoá định dạng". execCommand('removeFormat') only undoes the character-level
// marks it wrote itself, and not even all of those: several engines leave a
// <font size> standing. So the three things it cannot reach are taken off here -
// the block classes, any remaining <font>, and the highlight - and only within
// the selection, so clearing one paragraph does not strip the block around it.
function rtClearFormatting(editor) {
  document.execCommand('removeFormat', false, undefined);
  for (const el of rtSelectedBlocks(editor)) {
    for (const cls of RT_BLOCK_CLASSES) el.classList.remove(cls);
    if (!el.className) el.removeAttribute('class');
  }
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  for (const el of [...editor.querySelectorAll('font, .rt-mark, a')]) {
    if (!range.intersectsNode(el)) continue;
    // A link is a mark the author can re-add, so "clear" drops it like a <font>:
    // the text stays, the anchor goes.
    if (el.tagName === 'FONT' || el.tagName === 'A') {
      el.replaceWith(...el.childNodes);
      continue;
    }
    el.classList.remove('rt-mark');
    if (!el.className) el.removeAttribute('class');
    // A <span> whose only job was the class just removed. Unwrapped HERE rather
    // than left to unwrapBareSpans() on save: that pass is guarded on the block
    // still containing a style or a <font>, and clearing the formatting is
    // precisely what removes the last of those - so an empty wrapper would
    // otherwise be stored.
    if (!el.attributes.length && el.tagName === 'SPAN') el.replaceWith(...el.childNodes);
  }
}

// ---- Quotations ---------------------------------------------------------------
// Two features sharing one Vietnamese name, which is why the toolbar carries two
// buttons and not one:
//
//   "Trích dẫn" (format_quote) is a BLOCK wrapper - <blockquote class="rt-quote">
//     around the paragraph, list or table the caret is in. The reading page has
//     always painted .prose-content blockquote as the design's pull-quote, and
//     until this button existed nothing in the editor could produce one: the only
//     thing here that writes a <blockquote> is execCommand('indent'), and api.js
//     retags every one of those to <div class="rt-indent"> on save precisely so
//     an indent is never mistaken for a quotation. RT_QUOTE_CLASS is what now
//     tells the two apart, in both directions - isIndentBlockquote() refuses to
//     see a quote as an indent, and common.css refuses to set an indent as a
//     quotation. Stored and editor spelling are the SAME element, so unlike the
//     indent and the <font> marks there is no translation on the way in or out.
//   The “” pill is a CHARACTER-level mark: typographic quotes around the run the
//     author selected, folded to the one pair this site uses whichever pair the
//     text arrived with.
//
// The block one is a DOM write and so is not on the browser's undo stack - the
// trade rtApplyBlockClass() and the table picker already make. execCommand's own
// 'formatBlock' could have written the <blockquote>, but it REPLACES the block
// the caret is in rather than wrapping it: the paragraph inside the quotation
// would be gone, and the marks - which hang off the wrapper's first and last
// child - would have nothing left to hang off. The inline one goes through execCommand('insertText') and IS undoable,
// one continuous history with the B/I/U presses either side of it.
const RT_QUOTE_OPEN = '“';
const RT_QUOTE_CLOSE = '„';

// The quote the caret is inside, bounded by the editor - the same walk
// rtMarkState() does for a highlight and rtLinkAroundCaret() for a link. Bounded
// because the menus are parented to <body> and closest() would otherwise walk
// out of the paragraph into the page. null when the caret is in ordinary prose.
function rtQuoteAroundCaret(editor) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType !== 1) node = node.parentElement;
  if (!node || !node.closest || !editor.contains(node)) return null;
  const bq = node.closest('blockquote.' + RT_QUOTE_CLASS);
  return bq && editor.contains(bq) ? bq : null;
}

// Parents whose children are STRUCTURAL rather than flow content. A quote cannot
// be slipped between one of these and its children without producing markup no
// parser keeps - a <blockquote> between <tr> and <td> loses the cell, one
// between <ul> and <li> loses the item - so a caret inside a cell or an item
// quotes the whole table or the whole list instead. That is also what the author
// means by "quote this" when the caret is in either: nobody wants one item of a
// list quoted and the rest of the same list left outside the quotation.
const RT_QUOTE_STRUCTURAL = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'UL', 'OL', 'DL']);

function rtQuoteLift(el, editor) {
  let node = el;
  while (node.parentElement && node.parentElement !== editor && RT_QUOTE_STRUCTURAL.has(node.parentElement.tagName)) {
    node = node.parentElement;
  }
  return node;
}

// Takes the quotation off and leaves its contents exactly where it stood.
function rtUnwrapQuote(bq) {
  const parent = bq.parentNode;
  while (bq.firstChild) parent.insertBefore(bq.firstChild, bq);
  parent.removeChild(bq);
}

function rtWrapInQuote(editor) {
  // Lifted, then deduped: two cells of one table are one table, three items of a
  // list are one list.
  const lifted = [];
  for (const el of rtSelectedBlocks(editor)) {
    const top = rtQuoteLift(el, editor);
    if (!lifted.includes(top)) lifted.push(top);
  }
  // One wrapper per parent, over the run the selection actually covers. A
  // selection can reach blocks in different parents - a paragraph beside a
  // table - and a single wrapper would have to move one of them out of its own
  // parent to hold the other.
  const groups = [];
  for (const el of lifted) {
    const g = groups[groups.length - 1];
    if (g && g.parent === el.parentNode) g.items.push(el);
    else groups.push({ parent: el.parentNode, items: [el] });
  }
  let made = null;
  for (const g of groups) {
    // Already inside a quotation: a multi-parent selection can reach into one.
    // Extending the existing wrapper keeps it a single quotation - nesting a
    // second would put a second pair of marks around part of the same sentence.
    if (g.parent !== editor && g.parent.closest && g.parent.closest('blockquote.' + RT_QUOTE_CLASS)) continue;
    const bq = document.createElement('blockquote');
    bq.className = RT_QUOTE_CLASS;
    g.parent.insertBefore(bq, g.items[0]);
    for (const el of g.items) bq.appendChild(el);
    if (!made) made = bq;
  }
  return made;
}

function rtToggleQuote(editor) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  // Where the caret is BEFORE the markup moves. Wrapping and unwrapping
  // re-parent whole elements, and the text node the caret sits in travels with
  // them, so the same node at the same offset is still the right place
  // afterwards - which is what leaves the author mid-sentence instead of
  // dropping them at the top of the block they just quoted.
  const anchorNode = sel.anchorNode;
  const anchorOffset = sel.anchorOffset;

  const existing = rtQuoteAroundCaret(editor);
  let made = null;
  if (existing) rtUnwrapQuote(existing);
  else made = rtWrapInQuote(editor);

  if (anchorNode && (anchorNode === editor || editor.contains(anchorNode))) {
    try {
      const r = document.createRange();
      r.setStart(anchorNode, anchorOffset);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    } catch {
      // the node moved out from under that offset - fall through to the block
    }
  }
  const r = document.createRange();
  r.selectNodeContents(made || editor);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

// Terminal/code block: a labelled shell snippet, for the "run this" commands
// a security/infra blog leans on constantly (screenshots of aws/kubectl/curl
// invocations, always with a header naming what shell they are and a copy
// button). Two plain, directly-editable pieces - a one-line label
// (.rt-code-lang, "bash - AWS CLI") and the command body itself
// (.rt-code-body, a <pre><code>) - both nothing more exotic than a <div> and
// a <pre>, both tags server/sanitize-html.js already allows, under classes
// that already match its CLASS_RE (`rt-[a-z0-9-]+`) - so this needed NO
// sanitizer change at all, unlike almost every other block this toolbar
// writes.
// The "Sao chép" button visible on the published post is deliberately NOT
// part of what gets stored or even inserted here: a copy button has nothing
// to copy until the author has actually typed a command, and more to the
// point a stored <button onclick=...> is exactly the shape
// sanitizeRichHtml() exists to strip - inline handlers do not survive it,
// and could not be trusted to if they did. post.js's wireCodeBlocks() builds
// the real button at render time instead, off the plain .rt-code-lang/
// .rt-code-body structure below - see that function's own comment.
//
// Built and inserted as real DOM nodes, NOT execCommand('insertHTML', ...) -
// unlike every other insertion this toolbar does. Tested directly against a
// live editor: Chrome's insertHTML silently EATS a block-level element whose
// first child is another bare block with nothing else around it - exactly
// this shape (a wrapper <div> holding a label <div>/<p> then a <pre>) - it
// collapsed the outer wrapper's first child away entirely, leaving the label
// text stranded as a bare <span> appended to whatever paragraph the caret
// had been in. This was the actual cause of a report that the caret could
// not be moved out of a quote or a code block at all: the label had leaked
// into the SAME paragraph the "exit" logic in the two keydown handlers below
// was reading, confusing both. A direct DOM build sidesteps the browser's
// own HTML-parsing entirely, so nothing is left for it to "simplify" away -
// the same reasoning rtWrapInQuote()/rtUnwrapQuote() above already settled
// on for the identical class of problem, at the cost of the same trade: this
// is a DOM write, not on the browser's own undo stack.
function rtBlockHasContent(el) {
  return !!(el.textContent.trim() || el.querySelector('img, table'));
}

function rtInsertCodeBlock(editor) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return;
  if (!range.collapsed) range.deleteContents();

  const wrap = document.createElement('div');
  wrap.className = 'rt-code';
  const lang = document.createElement('div');
  lang.className = 'rt-code-lang';
  lang.textContent = 'bash';
  const pre = document.createElement('pre');
  pre.className = 'rt-code-body';
  const code = document.createElement('code');
  code.textContent = '# Nhập câu lệnh tại đây';
  pre.appendChild(code);
  wrap.append(lang, pre);

  // A <div> is not valid content inside a <p> (or inside .rt-quote's own
  // paragraphs) - splitting the current block in two around the caret, the
  // same shape pressing Enter would leave, is what keeps the block the code
  // is inserted at the END of, or in the MIDDLE of, still a well-formed
  // paragraph either side of it rather than a <div> nested somewhere the
  // content model forbids.
  const container = rtCurrentBlock(editor, { create: true });
  if (container && container !== editor) {
    const tailRange = document.createRange();
    tailRange.selectNodeContents(container);
    tailRange.setStart(range.endContainer, range.endOffset);
    const tail = container.cloneNode(false);
    tail.appendChild(tailRange.extractContents());

    container.after(wrap);
    if (rtBlockHasContent(tail)) wrap.after(tail);
    if (!rtBlockHasContent(container)) container.remove();
  } else {
    range.insertNode(wrap);
  }

  // Caret into the command body, ready to type over the seed text - the same
  // "insert and edit immediately" landing every other insert on this toolbar
  // gives (an image caption, a fresh table cell).
  const caretRange = document.createRange();
  caretRange.selectNodeContents(code);
  caretRange.collapse(false);
  sel.removeAllRanges();
  sel.addRange(caretRange);

  syncEditorToBlock(editor);
  saveRtSelection(editor);
}

// execCommand('insertText') leaves the caret COLLAPSED after what it wrote,
// which is wrong for a toggle: the author who presses the pair twice expects the
// second press to take the quotes back off, and with nothing selected the second
// press has nothing to read. So the run just written goes back under the
// selection, and the next press sees the pair and removes it.
function rtInsertTextSelected(text) {
  const sel = window.getSelection();
  document.execCommand('insertText', false, text);
  if (!sel.rangeCount) return;
  const r = sel.getRangeAt(0).cloneRange();
  if (r.startContainer.nodeType !== 3 || r.startOffset < text.length) return;
  try {
    r.setStart(r.startContainer, r.startOffset - text.length);
  } catch {
    return; // the insertion split the node; a collapsed caret is still usable
  }
  sel.removeAllRanges();
  sel.addRange(r);
}

// The pairs a paste or an older post can arrive with, folded to the one this
// site uses - which is a HIGH opening mark and a LOW closing one, so a paste
// carrying the English pair, the German pair the other way round, or the French
// guillemets all come out the same. Both sets list every double mark, opening
// and closing alike, because which end a mark belongs to is exactly what a paste
// from another language disagrees about. Doubles only - a leading or trailing APOSTROPHE is an English
// possessive or a contraction far more often than it is a quotation mark, and
// eating it would be a change to the author's words rather than to their
// punctuation. One character per side, anchored: a run that legitimately opens
// with two quotes keeps the second.
const RT_QUOTEISH_OPEN = /^[“”„‟«‹"]/u;
const RT_QUOTEISH_CLOSE = /[“”„‟»›"]$/u;

function rtToggleInlineQuote(editor) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !editor.contains(sel.anchorNode)) return;
  const text = sel.getRangeAt(0).toString();

  // Nothing selected: write the empty pair and leave the caret BETWEEN the two,
  // ready to type into. The pair is the point of the press, not a selection the
  // author has to make first and then find the button for.
  if (!text) {
    document.execCommand('insertText', false, RT_QUOTE_OPEN + RT_QUOTE_CLOSE);
    if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0).cloneRange();
    if (r.startContainer.nodeType !== 3 || !r.startOffset) return;
    try {
      r.setStart(r.startContainer, r.startOffset - 1);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch {
      // the caret after the pair is still a usable place to type
    }
    return;
  }

  const quoted = text.length > 1 && text.startsWith(RT_QUOTE_OPEN) && text.endsWith(RT_QUOTE_CLOSE);
  if (quoted) {
    rtInsertTextSelected(text.slice(1, -1));
    return;
  }
  const inner = text.replace(RT_QUOTEISH_OPEN, '').replace(RT_QUOTEISH_CLOSE, '');
  rtInsertTextSelected(RT_QUOTE_OPEN + inner + RT_QUOTE_CLOSE);
}

// ---- Hyperlinks --------------------------------------------------------------
// Word-shaped: the toolbar button opens a small dialog asking for the address and
// the display text, applied to whatever the author had selected. The <a> it writes
// is plain markup - the sanitizer already allowlists href with safe schemes
// (server/sanitize-html.js), so what this inserts survives the save round-trip.
// execCommand('createLink') alone is not enough: a collapsed caret has nothing to
// wrap, and editing an existing link's address or text is a replace, not a command.

// The anchor the caret sits in, bounded by the editor - the same walk rtMarkState
// does for highlights. null when the caret is not inside a link.
function rtLinkAroundCaret(editor) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType !== 1) node = node.parentElement;
  if (!node || !node.closest || !editor.contains(node)) return null;
  const a = node.closest('a');
  return a && editor.contains(a) ? a : null;
}

// Mirrors safeUrl() in server/sanitize-html.js: the schemes the sanitizer keeps
// are the only ones offered, so a link is never refused AFTER the author filled
// the dialog. A bare domain gets https:// the way a browser address bar assumes
// it; javascript:/data: and protocol-relative are dead on arrival.
function rtLinkNormalizeUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  const probe = v.replace(/[- \s]/g, '').toLowerCase();
  if (/^(?:javascript|data|vbscript|file):/.test(probe)) return null;
  if (/^[a-z][a-z0-9+.-]*:/.test(probe)) return v; // explicit safe-or-refused scheme
  if (probe.startsWith('//')) return null; // protocol-relative: another origin
  if (v.startsWith('/') || v.startsWith('#') || v.startsWith('?')) return v; // site-relative
  return `https://${v}`; // a bare domain is what an author types
}

// ---- The link dialog ---------------------------------------------------------
// One element for the page, parented to <body> like the dock and the menu. The
// selection is saved BEFORE the dialog opens - focusing its inputs collapses the
// range the apply step needs, exactly the problem saveRtSelection() exists for.
let rtLinkEl = null;
let rtLinkOpen = false;
let rtLinkEditing = null; // the <a> being edited, null when inserting a new one
let rtLinkCollapsed = true; // was the selection a caret when the dialog opened
let rtLinkSelectedText = '';

function rtLinkDialog() {
  if (rtLinkEl) return rtLinkEl;
  rtLinkEl = document.createElement('div');
  rtLinkEl.className = 'rt-link hidden';
  rtLinkEl.innerHTML = `
    <div class="rt-link-card" role="dialog" aria-modal="true" aria-label="Liên kết">
      <label>Địa chỉ liên kết
        <input type="text" class="rt-field rt-link-url" inputmode="url" placeholder="https://..." aria-label="Địa chỉ liên kết">
      </label>
      <label>Chữ hiển thị
        <input type="text" class="rt-field rt-link-text" placeholder="Để trống: giữ chữ đang chọn" aria-label="Chữ hiển thị">
      </label>
      <p class="rt-hint rt-link-error hidden"></p>
      <div class="rt-link-actions">
        <button type="button" class="rt-upload rt-link-unlink hidden">Gỡ liên kết</button>
        <span class="rt-link-spacer"></span>
        <button type="button" class="rt-upload rt-link-cancel">Huỷ</button>
        <button type="button" class="rt-link-save">Lưu</button>
      </div>
    </div>`;
  document.body.appendChild(rtLinkEl);

  rtLinkEl.querySelector('.rt-link-cancel').addEventListener('click', closeRtLink);
  rtLinkEl.querySelector('.rt-link-unlink').addEventListener('click', rtUnlink);
  rtLinkEl.querySelector('.rt-link-save').addEventListener('click', rtApplyLink);
  rtLinkEl.addEventListener('mousedown', (e) => {
    if (e.target === rtLinkEl) closeRtLink(); // the dimmed backdrop, not the card
  });
  rtLinkEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeRtLink();
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      rtApplyLink();
    }
  });
  return rtLinkEl;
}

function openRtLink() {
  const editor = restoreRtSelection() || activeRtEditor();
  if (!editor) return;
  saveRtSelection(editor);
  const sel = window.getSelection();
  rtLinkCollapsed = !sel.rangeCount || sel.isCollapsed;
  rtLinkSelectedText = sel.rangeCount ? String(sel) : '';

  const a = rtLinkAroundCaret(editor);
  rtLinkEditing = a;

  const dlg = rtLinkDialog();
  dlg.querySelector('.rt-link-url').value = a ? a.getAttribute('href') || '' : '';
  dlg.querySelector('.rt-link-text').value = a ? a.textContent : rtLinkSelectedText;
  dlg.querySelector('.rt-link-unlink').classList.toggle('hidden', !a);
  const err = dlg.querySelector('.rt-link-error');
  err.classList.add('hidden');
  err.textContent = '';

  rtLinkOpen = true;
  dlg.classList.remove('hidden');
  syncRtDock();
  dlg.querySelector('.rt-link-url').focus();
}

function closeRtLink() {
  if (!rtLinkEl) return;
  rtLinkEl.classList.add('hidden');
  rtLinkOpen = false;
  rtLinkEditing = null;
  syncRtDock();
}

// Applies the dialog. Three shapes, matching what Word's dialog covers:
//   editing     the caret was in a link - its href (and text, if changed) update;
//   wrapping    a real selection - createLink wraps it, then the display text
//               replaces it when the author asked for different words;
//   inserting   a bare caret - a fresh <a> with the display text is inserted.
function rtApplyLink() {
  const dlg = rtLinkDialog();
  const err = dlg.querySelector('.rt-link-error');
  const url = rtLinkNormalizeUrl(dlg.querySelector('.rt-link-url').value);
  if (!url) {
    err.textContent = 'Địa chỉ không hợp lệ. Dùng https://, mailto:, tel: hoặc đường dẫn trong trang.';
    err.classList.remove('hidden');
    return;
  }
  const editor = restoreRtSelection();
  if (!editor) return closeRtLink();

  let display = dlg.querySelector('.rt-link-text').value.trim();
  if (rtLinkEditing) {
    rtLinkEditing.setAttribute('href', url);
    if (display) rtLinkEditing.textContent = display;
  } else if (rtLinkCollapsed) {
    if (!display) display = url;
    document.execCommand('insertHTML', false, `<a href="${escapeHtml(url)}">${escapeHtml(display)}</a>`);
  } else {
    document.execCommand('createLink', false, url);
    const a = rtLinkAroundCaret(editor);
    if (a && display && display !== a.textContent) a.textContent = display;
  }

  syncEditorToBlock(editor);
  saveRtSelection(editor);
  syncRtToolbars();
  closeRtLink();
}

// "Gỡ liên kết" unwraps the anchor rather than execCommand('unlink'): unlink with
// a collapsed caret inside the link is a no-op on some engines, and the dialog
// only offers the button when there IS an anchor to unwrap.
function rtUnlink() {
  const editor = restoreRtSelection();
  if (rtLinkEditing) rtLinkEditing.replaceWith(...rtLinkEditing.childNodes);
  if (editor) {
    syncEditorToBlock(editor);
    saveRtSelection(editor);
    syncRtToolbars();
  }
  closeRtLink();
}

// ---- Images INSIDE a paragraph ---------------------------------------------
// An <img> at the caret, in the middle of the text - a different thing from the
// image BLOCK that "+ Ảnh" on the rail appends. A block can only sit between two
// other blocks; this lands between two WORDS when that is where the caret is, so
// a picture can illustrate the sentence it follows instead of interrupting the
// article somewhere near it. Two ways in, one path out:
//   paste    a screenshot or a copied picture reaches JavaScript as a File on
//            clipboardData. The handler below takes it, and when the clipboard
//            also carries text it keeps the text and puts the picture where the
//            source had it.
//   the menu "Chèn ảnh" on the docked toolbar: a file on this machine, one from
//            the library, or a URL that already exists somewhere.
// Out: the file goes to POST /api/media and the <img> finally written points at
// the /uploads/... path that comes back.
//
// It has to be uploaded, and that is not a nicety. A pasted screenshot arrives as
// a data: URL of several megabytes, and server/sanitize-html.js admits only
// http(s)/mailto/tel/ftp and scheme-less paths in a src - so an <img
// src="data:..."> dropped straight into the editor looks perfect right up to the
// moment the post is saved, and then quietly vanishes. Uploading first is what
// makes the editor an honest preview. It also files the picture in the media
// library, so the next post can reuse it without sending the bytes again - the
// same reason the image block's own upload goes to /api/media and not /api/upload.
//
// Uploads are async and the author keeps typing through them, so the picture
// cannot simply be inserted when it arrives: by then the caret is elsewhere. Each
// one drops a placeholder chip at the exact spot it was asked for, and swaps that
// chip for the <img> when the upload resolves. Nothing here is addressed by
// element reference - renderBlocks() replaces every editor in the DOM when a block
// is added, moved or deleted, and an author who pastes a picture and then clicks
// "+ Ảnh" would otherwise wait for an upload that lands in a detached node. The
// block's key and the chip's id are stable across a re-render, so everything is
// looked up again at the moment it is needed.

let rtPendingSeq = 0;
const rtPendingUploads = new Set();
// Counted so a save that had to wait can say how many of the pictures it waited
// for never arrived. Without it the post saves with the failures silently missing
// from it, and the only record is a red line under a paragraph the author may have
// scrolled past.
let rtUploadFailures = 0;

// The paragraph the caret is in, plus the range to write to. The key is what
// makes it survive a re-render; the range is live, so text typed around it shifts
// its offsets rather than invalidating them.
function rtInsertTarget(editor) {
  return { key: editor.dataset.key, range: rtCaptureRange(editor) };
}

function rtLiveEditor(key) {
  return document.querySelector(`.rt-editor[data-key="${key}"]`);
}

function rtCaptureRange(editor) {
  const sel = window.getSelection();
  if (sel && sel.rangeCount && editor.contains(sel.getRangeAt(0).startContainer)) {
    return sel.getRangeAt(0).cloneRange();
  }
  // Opening a menu or a dialog moves focus out of the editor and collapses its
  // range, which is the whole reason savedRtSelection exists.
  if (savedRtSelection && savedRtSelection.editor === editor && document.contains(editor)) {
    return savedRtSelection.range.cloneRange();
  }
  return null;
}

// Where a drop landed, as a range inside the editor. caretRangeFromPoint is
// Chrome/Safari/WebKit and caretPositionFromPoint is Firefox; with neither there
// is no honest answer, so null comes back and the caller falls back to wherever
// the caret already was. Bounded by the editor: a drop on the block's padding, or
// on the chip of an upload still running, resolves to a node outside the text and
// must not be written to.
function rtRangeFromPoint(editor, x, y) {
  let range = null;
  if (typeof document.caretRangeFromPoint === 'function') {
    range = document.caretRangeFromPoint(x, y);
  } else if (typeof document.caretPositionFromPoint === 'function') {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos && pos.offsetNode) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
    }
  }
  return range && editor.contains(range.startContainer) ? range : null;
}

// Writes markup at a target. execCommand('insertHTML') rather than
// range.insertNode() so the insertion lands on the browser's OWN undo stack:
// Ctrl+Z after a pasted picture has to take the picture back out, and a DOM write
// this code did by hand would be invisible to undo - which is why the whole
// toolbar is execCommand too.
function rtInsertAtTarget(target, html) {
  const editor = rtLiveEditor(target.key);
  // The block was deleted while a dialog was open. Nothing to write into, and
  // appending to a detached element would be a silent no-op the author waits for.
  if (!editor) return null;

  const range = target.range && editor.contains(target.range.startContainer) ? target.range : null;
  if (range) {
    editor.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    if (document.execCommand('insertHTML', false, html)) {
      syncEditorToBlock(editor);
      saveRtSelection(editor);
      // Read the caret back rather than computing where the chip went: insertHTML
      // splits a text node to make room and only the engine knows where that
      // landed. This is what lets a second file be placed AFTER the first instead
      // of on top of it, so "insert these four pictures here" keeps their order.
      return rtInsertTarget(editor);
    }
  }
  // No usable range - the paragraph it pointed into has been typed away, or an
  // engine refused the command. Append rather than drop: losing a picture the
  // author has already waited for is worse than putting it at the end of the
  // block they asked for.
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  editor.appendChild(tpl.content);
  syncEditorToBlock(editor);
  return rtInsertTarget(editor);
}

// The chip that holds a picture's place. Its label is its own element so the
// progress percentage can be written without touching the icon beside it.
// contenteditable="false" makes it one ATOMIC thing inside the paragraph: the
// author cannot type into it and corrupt the label, the caret can still be placed
// on either side of it, and one Backspace takes the whole chip out rather than
// deleting it a character at a time. The attribute is not in the sanitizer's
// allowlist, so a chip that somehow reached a save would come back as an ordinary
// span - which is one more reason no chip is ever allowed to reach one.
function rtPendingChipHtml(id, label) {
  return `<span class="rt-inline-pending" data-rt-pending="${id}" contenteditable="false">` +
    `<span class="material-symbols-outlined" aria-hidden="true">sync</span>` +
    `<span class="rt-inline-pending-label">${escapeHtml(label)}</span></span>`;
}

// The same chip as a node, for replacing an element that is already in the tree -
// a pasted <img> being swapped out for the upload it is waiting on.
function rtPendingChipNode(id, label) {
  const tpl = document.createElement('template');
  tpl.innerHTML = rtPendingChipHtml(id, label);
  return tpl.content.firstElementChild;
}

// ---- Pictures the BROWSER pasted, not this code ------------------------------
// The takeover in rtHandleEditorPaste() is the good path: it knows which clipboard
// file belongs in which slot and it puts a chip there before the first byte moves.
// It is not the only path, and treating it as the only one is what loses pictures.
// An engine whose DataTransferItemList is not iterable, a clipboard that exposes
// the image only inside text/html, a throw anywhere in the handler, or simply a tab
// that was opened before this file was edited - any of those leaves the browser to
// its own default, and Chrome's default for a screenshot is to insert
//   <div><img src="data:image/png;base64,…"></div>
// into the paragraph. That renders perfectly while the author writes and then
// vanishes on save, because safeUrl() in server/sanitize-html.js admits only
// http(s)/mailto/tel/ftp and scheme-less paths: what comes back out of the
// sanitizer is `<img alt="">`, which paints nothing at all. An article with two of
// those in it has two invisible holes where the author counted two pictures.
//
// So the bytes are adopted rather than trusted to arrive by one route. A data: URL
// still holds the whole file, and it is decoded and uploaded here; whatever cannot
// be recovered - blob:, file://, a src the sanitizer already blanked - is removed
// instead of being left as a hole.

// data: URL -> File. atob rather than fetch(dataUrl): a fetch of a data: URL works
// but routes a string that is already in memory through the network stack, and
// this needs no CSP exception for `data:` in connect-src either.
function rtDataUrlToFile(dataUrl) {
  const m = /^data:([^;,]*)?(;base64)?,([\s\S]*)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const mime = (m[1] || '').trim().toLowerCase();
  // Only pictures, and only the four the upload route accepts: ALLOWED_EXT in
  // server/media-store.js is checked against the FILENAME, so the extension has to
  // be invented here and inventing ".svg" for a paste the server would refuse is
  // just a slower way to say no.
  if (!/^image\/(png|jpeg|jpg|webp|gif)$/i.test(mime)) return null;
  const raw = (m[3] || '').replace(/\s/g, '');
  let bytes;
  try {
    if (m[2]) {
      const bin = atob(raw);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(raw));
    }
  } catch {
    return null; // a truncated or malformed data URL - nothing to recover
  }
  if (!bytes.length) return null;
  const ext = /^image\/jpe?g$/i.test(mime) ? 'jpg' : mime.split('/')[1].toLowerCase();
  return new File([bytes], `pasted-${Date.now()}.${ext}`, { type: mime });
}

// Chrome pastes a picture inside a wrapper of its own making - <div><img></div> -
// and once the picture is gone the wrapper is an empty box that would ride along
// into the saved post forever. Remove the picture, and its wrapper too, but only
// when the picture was the whole of the wrapper's contents: <p>chữ <img></p> has
// to keep its text. (The parent is read before the removal, not after - a removed
// node has no parentNode left to ask about.)
function rtDropEmptyWrapper(img, root) {
  const parent = img.parentNode;
  img.remove();
  // Upward, and more than once: a picture pasted into a nested structure can be
  // <div><div><img></div></div>, and clearing the inner box empties the outer one.
  for (let box = parent; box && box !== root && !box.childNodes.length; ) {
    const up = box.parentNode;
    box.remove();
    box = up;
  }
}

// Walks one editor for pictures that cannot survive a save and gives each a real
// /uploads/ src. Called after a paste this code did NOT take over, and on every
// renderBlocks() - which is what cleans up a draft saved before this existed,
// where the holes are already in the stored html.
function rtAdoptStrayImages(editor) {
  if (!editor) return 0;
  const key = editor.dataset.key;
  let changed = 0;
  let uploading = 0;

  for (const img of [...editor.querySelectorAll('img')]) {
    // A picture pointing somewhere the sanitizer keeps is exactly what was asked
    // for; leave it alone.
    if (rtImgSrcSurvives(img.getAttribute('src'))) continue;
    const file = rtDataUrlToFile(img.getAttribute('src'));
    if (!file) {
      // No bytes to recover: blob: and file:// are opaque to script, and an <img>
      // with no src is what a stripped data: comes back as. Either way it paints
      // nothing, so it goes rather than being carried into the saved post - along
      // with the wrapper Chrome pasted it inside, if the picture was all it held.
      rtDropEmptyWrapper(img, editor);
      changed++;
      continue;
    }
    const id = `rt${++rtPendingSeq}`;
    // The chip replaces the picture for the length of the upload. The data: URL is
    // not kept as its own preview on purpose: syncEditorToBlock() stores
    // editor.innerHTML, and holding a 7 MB base64 string in the model so it can be
    // re-rendered is a lot of memory for a preview that says less than "43%".
    img.replaceWith(rtPendingChipNode(id, 'Đang tải ảnh lên...'));
    rtUploadForChip(key, id, file);
    changed++;
    uploading++;
  }

  if (changed) syncEditorToBlock(editor);
  if (uploading) {
    rtParagraphStatus(
      key,
      uploading === 1
        ? 'Ảnh dán vào đang được tải lên thư viện...'
        : `Đang tải ${uploading} ảnh dán vào lên thư viện...`,
      false
    );
  }
  return changed;
}

// The same sweep over the stored html, at the last moment before a save. Belt to
// rtAdoptStrayImages()'s brace: a block the author never re-rendered and never
// typed into would otherwise carry its dead <img> straight to the server, which
// would blank the src and store the hole.
function rtStripDeadImages(html) {
  const source = String(html || '');
  if (!/<img/i.test(source)) return source;
  const tpl = document.createElement('template');
  tpl.innerHTML = source;
  let changed = false;
  for (const img of [...tpl.content.querySelectorAll('img')]) {
    if (rtImgSrcSurvives(img.getAttribute('src'))) continue;
    rtDropEmptyWrapper(img, tpl.content);
    changed = true;
  }
  return changed ? tpl.innerHTML : source;
}

// The status line under a paragraph editor - this block's answer to the
// .block-image-status an image block carries. A success clears itself: an upload
// finishes while the author is mid-sentence, and a line left saying "Đã chèn ảnh"
// under every paragraph they ever pasted into is noise. An error stays until
// something else happens, because it is the only record of why a picture did not
// arrive.
const rtStatusTimers = new WeakMap();
function rtParagraphStatus(key, message, isError) {
  const el = document.querySelector(`.block-paragraph-status[data-key="${key}"]`);
  if (!el) return;
  const prev = rtStatusTimers.get(el);
  if (prev) clearTimeout(prev);
  el.textContent = message;
  el.classList.remove('hidden');
  el.classList.toggle('text-error', Boolean(isError));
  if (!isError) rtStatusTimers.set(el, setTimeout(() => el.classList.add('hidden'), 4000));
}

// A batch of files at one spot: a chip each, in order, written by ONE insertHTML,
// then all the uploads started. One call rather than one per file so "drop these
// four here" keeps their order and costs the author one Ctrl+Z to take back.
// Shared by the paste handler, the drop handler and the toolbar's file picker.
function rtPlaceFiles(target, files) {
  const waiting = files.map((file) => ({ id: `rt${++rtPendingSeq}`, file }));
  if (!waiting.length) return 0;
  const placed = rtInsertAtTarget(
    target,
    waiting.map((w) => rtPendingChipHtml(w.id, 'Đang tải ảnh lên...')).join('')
  );
  // The block was deleted while a dialog was open; there is nowhere to put them.
  if (!placed) return 0;
  for (const w of waiting) rtUploadForChip(placed.key, w.id, w.file);
  rtParagraphStatus(
    placed.key,
    waiting.length === 1 ? 'Đang tải ảnh lên...' : `Đang tải ${waiting.length} ảnh lên...`,
    false
  );
  return waiting.length;
}

function rtUploadForChip(key, chipId, file) {
  const chip = () => {
    const editor = rtLiveEditor(key);
    return editor && editor.querySelector(`[data-rt-pending="${chipId}"]`);
  };

  const task = (async () => {
    let url;
    try {
      ({ url } = await API.uploadImage(file, {
        endpoint: '/media',
        onProgress: (ratio, loaded, total) => {
          const label = chip()?.querySelector('.rt-inline-pending-label');
          if (label) label.textContent = `Đang tải ảnh lên ${Math.round(ratio * 100)}% (${formatUploadBytes(loaded)} / ${formatUploadBytes(total)})`;
        },
      }));
    } catch (err) {
      // The chip comes OUT rather than being left in the paragraph as a visible
      // failure: a red pill in the middle of a sentence is markup the author would
      // have to delete by hand, and it would be SAVED - rt-inline-pending is a
      // well-formed rt-* class, so the sanitizer would happily keep it. The reason
      // is said where this block says everything else, under the editor.
      chip()?.remove();
      rtUploadFailures++;
      const editor = rtLiveEditor(key);
      if (editor) syncEditorToBlock(editor);
      rtParagraphStatus(key, `Không tải được ảnh: ${err.message}`, true);
      return;
    }

    const el = chip();
    // The author deleted the placeholder while it was uploading. The picture is in
    // the library now, which is not nothing - but it is not going into the post
    // over an explicit removal.
    if (!el) return;

    const img = document.createElement('img');
    // setAttribute rather than the IDL properties: what syncEditorToBlock() stores
    // is editor.innerHTML, and this is the one place where a property that an
    // engine happens not to reflect into the markup would silently lose the
    // attribute from the saved post.
    img.setAttribute('src', url);
    // An empty alt is the correct value for a picture with no caption: it tells a
    // screen reader "this is decoration, keep reading", where a filename read out
    // loud is noise. The image block's own caption field is where a description
    // goes, and a paragraph has the sentence around it.
    img.setAttribute('alt', '');
    img.setAttribute('class', 'rt-inline-img');
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');

    // The caret moves past the picture only if it is still in THIS paragraph. An
    // upload that finished while the author was writing the next block must not
    // yank them back to the previous one.
    const editor = rtLiveEditor(key);
    const hadCaret = !!editor && document.activeElement === editor;
    el.replaceWith(img);
    if (editor) {
      if (hadCaret) {
        const after = document.createRange();
        after.setStartAfter(img);
        after.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(after);
        saveRtSelection(editor);
      }
      syncEditorToBlock(editor);
      syncRtToolbars();
    }
    rtParagraphStatus(key, 'Đã chèn ảnh.', false);
  })();

  rtPendingUploads.add(task);
  // then(done, done) rather than task.finally(): a finally left on a promise that
  // rejects produces a SECOND unhandled rejection, and a promise that never
  // settles would sit in the set forever and hang every later save.
  const done = () => rtPendingUploads.delete(task);
  task.then(done, done);
}

// ---- Paste: a copied picture belongs where the caret is ----------------------
// Chrome, Firefox and Safari all hand a screenshot to a paste event as a File, and
// all three ALSO let the browser's own default run - which inserts that file as an
// <img src="data:..."> or inserts nothing at all, depending on the engine and on
// whether the clipboard also carried text. Both outcomes are wrong here: the data:
// URL is stripped on save (see the header above) and nothing-at-all looks like the
// paste failed. So the default is taken over only when there IS a picture on the
// clipboard; a text-only paste is left entirely to the browser, whose own handling
// of a rich paste is better than anything rebuilt here.
function rtClipboardImages(dt) {
  if (!dt) return [];
  const out = [];
  // items first: it is the only place some engines expose a screenshot, which has
  // no file name and therefore no entry a MIME check on dt.files can find. files
  // is the plain case - a picture copied from a folder or from a web page.
  //
  // Indexed loops, not for...of, and the whole thing wrapped: DataTransferItemList
  // is an array-LIKE whose Symbol.iterator is not there in every engine, and a
  // throw escaping from here would land in the paste listener before
  // preventDefault() had run - which is the worst possible outcome, because the
  // browser would then paste its own data: image AND nothing would have said why.
  // Returning [] is the honest answer: it means "let the browser paste, and let
  // rtAdoptStrayImages() pick the picture up out of the markup".
  try {
    const items = dt.items;
    if (items && typeof items.length === 'number') {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item && item.kind === 'file' && /^image\//.test(item.type || '')) {
          const f = item.getAsFile();
          if (f) out.push(f);
        }
      }
    }
    // Fallback, not a second source: where both are populated they are the same
    // pictures, and reading both would upload every one of them twice.
    if (!out.length) {
      const files = dt.files;
      if (files && typeof files.length === 'number') {
        for (let i = 0; i < files.length; i++) {
          if (/^image\//.test(files[i].type || '')) out.push(files[i]);
        }
      }
    }
  } catch {
    return [];
  }
  return out;
}

// A src the save pipeline would keep: an http(s) URL, or a path on this site.
// Everything else - data:, blob:, file://, cid: from an Outlook paste - is
// stripped by sanitizeRichHtml() on save, so an <img> carrying one is a picture
// the reader never sees.
function rtImgSrcSurvives(src) {
  const v = String(src || '').trim();
  if (!v) return false;
  if (v.startsWith('/') && !v.startsWith('//')) return true;
  return /^https?:\/\//i.test(v);
}

// Strips what a paste can carry that must not be dropped into a live editor.
//
// This is NOT the security control - sanitizeRichHtml() on the server is, and it
// runs on every save. This is editor hygiene with one specific job: the markup
// below is about to be written into a contenteditable by execCommand, and inline
// event handlers on pasted elements fire the moment the element is created. An
// <img onerror=...> copied off a hostile page would run in the author's own
// session, where the token lives in localStorage - exactly the scenario the header
// of server/sanitize-html.js is about. Letting the browser's own paste do this
// instead is not safer: it is the same insertion with a filter we do not control.
const RT_PASTE_DROP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'APPLET', 'LINK', 'META', 'BASE',
  'FORM', 'INPUT', 'BUTTON', 'SELECT', 'OPTION', 'TEXTAREA', 'SVG', 'MATH',
  'TEMPLATE', 'NOSCRIPT', 'NOEMBED', 'NOFRAMES', 'FRAME', 'FRAMESET', 'XMP',
  'PLAINTEXT', 'AUDIO', 'VIDEO', 'SOURCE', 'TRACK', 'CANVAS', 'MAP', 'AREA', 'PORTAL',
]);

// A paste defaults to "Đoạn văn thường" (Normal paragraph), never to whatever
// heading level the source happened to use - feedback, after a paste from a
// page/Word doc brought its own <h1>/<h2> structure straight into the
// article. The dedicated "Tiêu đề 2/3" toolbar option (headingFormat above)
// still works exactly as before: that one turns a line INTO an <h2>/<h3> by
// deliberate choice, this only unwraps headings that arrived UNASKED, inside
// pasted markup. Text and inline formatting (bold/italic/links) are kept -
// only the heading WRAPPER goes, replaced with a plain <p> holding the same
// children, so "Chương 1" pasted as an <h2> becomes a paragraph that still
// reads "Chương 1", not a paragraph that lost the word.
//
// `skip` is how the whole-editor call site (the plain-paste path, which has
// no isolated fragment to scope to - see the paste listener) tells a heading
// the author placed there on purpose, before this paste, from one the paste
// itself just brought in: only the latter gets flattened.
function rtFlattenHeadings(root, skip) {
  for (const h of [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')]) {
    if (skip && skip.has(h)) continue;
    const p = document.createElement('p');
    while (h.firstChild) p.appendChild(h.firstChild);
    h.replaceWith(p);
  }
}

function rtCleanPastedFragment(root) {
  rtFlattenHeadings(root);
  // Tables arrive with the source's widths, colours and class names: drop them
  // (see rtTblClean) so a pasted table takes the article's own table style.
  for (const t of root.querySelectorAll('table')) rtTblClean(t);
  for (const el of [...root.querySelectorAll('*')]) {
    if (RT_PASTE_DROP_TAGS.has(el.tagName)) {
      // Whole subtree, not just the tag: the contents of these are parsed as raw
      // text or as a foreign namespace, which is the seam the server sanitizer
      // skips them for. Same reason here.
      el.remove();
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') {
        el.removeAttribute(attr.name);
      } else if ((name === 'src' || name === 'href') && !rtImgSrcSurvives(attr.value) && !/^mailto:|^tel:/i.test(attr.value.trim())) {
        // Dropped rather than rewritten: an <a> keeps its text and a broken
        // picture is better absent than present and unrenderable.
        el.removeAttribute(attr.name);
      } else if (name === 'style' && /url\s*\(|expression\s*\(/i.test(attr.value)) {
        // The server refuses the same two shapes in a declaration value, and for
        // the same reason: a url() here is a request to a third origin made by the
        // author's browser while they write.
        el.removeAttribute(attr.name);
      }
    }
  }
  // And the type, for the reason normalizeInheritedTypography() itself explains
  // at length (js/api.js): a paste from Google Docs, Word or another site's
  // article arrives wrapped in its OWN font-family, an absolute pt/px size,
  // and often a fixed line-height - inline declarations that beat the
  // article's stylesheet outright, so the pasted passage sat in a foreign
  // face at a foreign size while the rest of the paragraph read in the
  // site's own type. This used to only run on SAVE (normalizeRichTextHtml()
  // in js/api.js), which fixed the STORED post but left the paste looking
  // wrong the whole time it was being edited - the exact moment an author is
  // looking at it and would notice. Running it here too means what a paste
  // looks like the instant it lands is already what gets stored.
  normalizeInheritedTypography(root);
  // And the colours, so that what the author sees is what the reader will get.
  // This fragment is about to be inserted into a surface that has two themes, and
  // a paste out of Google Docs or Word wraps its runs in `color:#000000` - an
  // inline declaration beats every stylesheet rule including the token the .dark
  // class moves, so on the dark theme that paste is black on near-black and reads
  // as though nothing arrived. stripLiteralColours() is the same pass the publish
  // direction runs (js/api.js), so this is one rule applied earlier, not a second
  // rule of its own. The <span>s it empties are left in place: removing elements
  // the caret is about to be placed into is how a paste loses the author's place,
  // and an empty wrapper is invisible until the save pass unwraps it.
  //
  // markInlineHighlights() first, and that order is the whole trick: it recognises
  // a highlight BY its inline background, so a pasted highlight has to reach it
  // with the background still on. Run the other way round and a paste that was
  // highlighted in the source would arrive with no highlight at all instead of
  // arriving with the themed one - the same reason the publish direction runs them
  // in this order.
  markInlineHighlights(root);
  stripLiteralColours(root);
}

// Returns whether the paste was taken over. false means the browser's own default
// ran, and the caller then has to look at what it produced - see the paste
// listener in the wiring section below.
function rtHandleEditorPaste(editor, e) {
  const dt = e.clipboardData;
  const files = rtClipboardImages(dt);
  // No picture this code can see: leave the paste to the browser, whose own
  // handling of text and rich markup is better than a reconstruction. If there IS
  // a picture and it simply was not exposed as a File, rtAdoptStrayImages() picks
  // it up out of the markup the browser inserts.
  if (!files.length) return false;
  e.preventDefault();

  const target = rtInsertTarget(editor);
  const rawHtml = dt.getData('text/html');
  const rawText = dt.getData('text/plain');
  const waiting = []; // { id, file } - chips placed into the markup, not yet uploading
  const queue = files.slice();
  let html = '';

  if (rawHtml && rawHtml.trim()) {
    // A template, not a div: nothing in it loads, so a pasted <img src="https://…">
    // does not fire a request to a third origin before this code has decided
    // whether to keep it.
    const tpl = document.createElement('template');
    tpl.innerHTML = rawHtml;
    rtCleanPastedFragment(tpl.content);
    // A picture the source referenced by a URL that survives sanitizing is left
    // alone - it is already what the reader will see. One referenced by data:,
    // blob: or file:// is not, and THAT is the slot a clipboard file fills: an
    // image copied off a web page arrives as both (an <img> in the html and the
    // same bytes in .files), so filling the slot is also what stops it appearing
    // twice.
    for (const img of [...tpl.content.querySelectorAll('img')]) {
      if (rtImgSrcSurvives(img.getAttribute('src'))) continue;
      const file = queue.shift();
      if (!file) {
        // Nothing to replace it with; a dead src is worse than no img.
        rtDropEmptyWrapper(img, tpl.content);
        continue;
      }
      const id = `rt${++rtPendingSeq}`;
      img.replaceWith(rtPendingChipNode(id, 'Đang tải ảnh lên...'));
      waiting.push({ id, file });
    }
    html = tpl.innerHTML;
  } else {
    // A bare screenshot: no text part at all. Escaped rather than inserted, since
    // text/plain is not markup and a filename with a "<" in it is a real thing.
    html = escapeHtml(rawText || '').replace(/\n/g, '<br>');
  }

  // Anything still in the queue had no dead <img> to fill - a screenshot pasted
  // into a paragraph that already had text, or three files copied from a folder.
  // They go after whatever was just pasted, which is where the author expects
  // them.
  if (!html.trim()) {
    // No text part at all - a bare screenshot, or a picture copied from a page that
    // put nothing in text/html. Skip the empty insertHTML and let rtPlaceFiles()
    // focus the editor and write the chips itself.
    if (queue.length) rtPlaceFiles(target, queue);
    return true;
  }

  // insertHTML first and the uploads after: a chip has to exist in the DOM before
  // anything can look it up to report progress on it, or to swap it out.
  const placed = rtInsertAtTarget(target, html);
  if (!placed) return true; // taken over, but the block was deleted underneath it
  for (const { id, file } of waiting) rtUploadForChip(placed.key, id, file);
  if (waiting.length) {
    rtParagraphStatus(
      placed.key,
      waiting.length === 1 ? 'Đang tải ảnh lên...' : `Đang tải ${waiting.length} ảnh lên...`,
      false
    );
  }
  if (queue.length) rtPlaceFiles(placed, queue);
  return true;
}

// ---- Chèn ảnh: the three ways in ---------------------------------------------
function rtInsertImage(target, how) {
  if (how === 'upload') return rtPickInlineFile(target);
  if (how === 'library') return rtInlineFromLibrary(target);
  if (how === 'url') return openRtImageUrl(target);
}

// ONE hidden file input for the page, reused by every "Tải ảnh lên" the toolbar
// offers - not one per paragraph. renderBlocks() replaces the whole DOM under the
// author's hands, and an <input type="file"> swapped out between the click and the
// change event never fires: the picker answers to the element that opened it.
// Parented to <body>, where no re-render reaches.
let rtInlineFileEl = null;
let rtInlineFileTarget = null;

function rtPickInlineFile(target) {
  if (!rtInlineFileEl) {
    rtInlineFileEl = document.createElement('input');
    rtInlineFileEl.type = 'file';
    rtInlineFileEl.accept = 'image/png,image/jpeg,image/webp,image/gif';
    // Several at once: a post illustrating four steps is four picks otherwise, and
    // the four would each cost their own undo step and their own wait.
    rtInlineFileEl.multiple = true;
    rtInlineFileEl.className = 'hidden';
    rtInlineFileEl.tabIndex = -1;
    rtInlineFileEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(rtInlineFileEl);
    rtInlineFileEl.addEventListener('change', () => {
      // Cleared before the files are read into a local: picking the SAME picture
      // twice in a row fires no change event on an input that still holds it, and
      // "put that one in again" is a thing an author does.
      const picked = Array.from(rtInlineFileEl.files || []);
      rtInlineFileEl.value = '';
      const at = rtInlineFileTarget;
      rtInlineFileTarget = null;
      if (!at || !picked.length) return;
      rtPlaceFiles(at, picked);
    });
  }
  rtInlineFileTarget = target;
  rtInlineFileEl.click();
}

async function rtInlineFromLibrary(target) {
  // Degrades to nothing rather than throwing when js/media.js is missing, exactly
  // as the image block's "Thư viện" button does.
  if (typeof openMediaPicker !== 'function') {
    rtParagraphStatus(target.key, 'Thư viện ảnh chưa sẵn sàng.', true);
    return;
  }
  const chosen = await openMediaPicker();
  if (!chosen || !chosen.url) return;
  // No upload to wait for, so no chip: the picture is already on the server and
  // goes straight in.
  rtInsertAtTarget(target, rtInlineImgHtml(chosen.url));
  rtParagraphStatus(target.key, 'Đã chèn ảnh từ thư viện.', false);
}

function rtInlineImgHtml(url) {
  return `<img src="${escapeHtml(url)}" alt="" class="rt-inline-img" loading="lazy" decoding="async">`;
}

// ---- The image-URL dialog ----------------------------------------------------
// The third way in, for a picture that already lives somewhere. Built from the
// link dialog's classes rather than a copy of them: two dialogs on one page that
// each ask for one address should be one material, and .rt-link already sits above
// the dock (80) and the menus (90) at 210.
let rtImageUrlEl = null;
let rtImageUrlOpen = false;
let rtImageUrlTarget = null;

function rtImageUrlDialog() {
  if (rtImageUrlEl) return rtImageUrlEl;
  rtImageUrlEl = document.createElement('div');
  rtImageUrlEl.className = 'rt-link hidden';
  rtImageUrlEl.innerHTML = `
    <div class="rt-link-card" role="dialog" aria-modal="true" aria-label="Chèn ảnh từ đường dẫn">
      <label>Địa chỉ ảnh
        <input type="text" class="rt-field rt-image-url" inputmode="url" placeholder="https://... hoặc /uploads/..." aria-label="Địa chỉ ảnh">
      </label>
      <img class="rt-image-url-preview hidden" alt="Xem trước ảnh">
      <p class="rt-hint rt-image-url-error hidden"></p>
      <p class="rt-hint">Ảnh được chèn đúng chỗ con trỏ đang đứng, bên trong đoạn văn. Ảnh tải lên từ máy thì dùng "Tải ảnh lên" — ảnh ở đây không được lưu vào thư viện.</p>
      <div class="rt-link-actions">
        <span class="rt-link-spacer"></span>
        <button type="button" class="rt-upload rt-image-url-cancel">Huỷ</button>
        <button type="button" class="rt-link-save">Chèn ảnh</button>
      </div>
    </div>`;
  document.body.appendChild(rtImageUrlEl);

  const input = rtImageUrlEl.querySelector('.rt-image-url');
  const preview = rtImageUrlEl.querySelector('.rt-image-url-preview');
  // A preview, because "paste a URL and see nothing until it is in the article" is
  // how a wrong URL gets published. It is the author's own browser fetching a
  // picture they typed, so nothing is proxied and nothing is stored.
  // Debounced: without it, typing "https://example.com/a.png" one character at a
  // time fires a request at every prefix of it, eleven of which are 404s aimed at
  // somebody else's server.
  let previewTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(previewTimer);
    const url = input.value.trim();
    if (!rtImgSrcSurvives(url)) {
      preview.classList.add('hidden');
      preview.removeAttribute('src');
      return;
    }
    previewTimer = setTimeout(() => {
      // Re-read rather than trusting the closed-over value: the dialog can be shut
      // and reopened inside the delay, and an empty field with the previous
      // address's picture under it is worse than an empty field.
      if (input.value.trim() !== url) return;
      preview.src = url;
      preview.classList.remove('hidden');
    }, 350);
  });
  preview.addEventListener('load', () => rtImageUrlError(''));
  preview.addEventListener('error', () => {
    preview.classList.add('hidden');
    rtImageUrlError('Không tải được ảnh ở địa chỉ này. Kiểm tra lại đường dẫn, hoặc tải ảnh lên từ máy.');
  });
  rtImageUrlEl.querySelector('.rt-image-url-cancel').addEventListener('click', closeRtImageUrl);
  rtImageUrlEl.querySelector('.rt-link-save').addEventListener('click', rtApplyImageUrl);
  rtImageUrlEl.addEventListener('mousedown', (e) => {
    if (e.target === rtImageUrlEl) closeRtImageUrl(); // the dimmed backdrop, not the card
  });
  rtImageUrlEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeRtImageUrl();
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      rtApplyImageUrl();
    }
  });
  return rtImageUrlEl;
}

function rtImageUrlError(message) {
  const el = rtImageUrlDialog().querySelector('.rt-image-url-error');
  if (!message) return el.classList.add('hidden');
  el.textContent = message;
  el.classList.remove('hidden');
}

function openRtImageUrl(target) {
  rtImageUrlTarget = target;
  const dlg = rtImageUrlDialog();
  dlg.querySelector('.rt-image-url').value = '';
  dlg.querySelector('.rt-image-url-preview').classList.add('hidden');
  dlg.querySelector('.rt-image-url-preview').removeAttribute('src');
  rtImageUrlError('');
  rtImageUrlOpen = true;
  dlg.classList.remove('hidden');
  syncRtDock();
  dlg.querySelector('.rt-image-url').focus();
}

function closeRtImageUrl() {
  if (!rtImageUrlEl) return;
  rtImageUrlEl.classList.add('hidden');
  rtImageUrlOpen = false;
  rtImageUrlTarget = null;
  syncRtDock();
}

function rtApplyImageUrl() {
  const dlg = rtImageUrlDialog();
  const url = dlg.querySelector('.rt-image-url').value.trim();
  // The same two shapes safeImageUrl() in server/routes/posts.js accepts, checked
  // here so the author hears it from the dialog rather than watching the picture
  // not appear after publishing.
  if (!rtImgSrcSurvives(url)) {
    rtImageUrlError('Địa chỉ không hợp lệ. Dùng https://... hoặc một đường dẫn /uploads/... trên trang này.');
    return;
  }
  if (!rtImageUrlTarget) return closeRtImageUrl();
  rtInsertAtTarget(rtImageUrlTarget, rtInlineImgHtml(url));
  rtParagraphStatus(rtImageUrlTarget.key, 'Đã chèn ảnh.', false);
  closeRtImageUrl();
}

// ---- The docked toolbar -----------------------------------------------------
// ONE toolbar for the page, built on first use and parented to <body>, pinned to
// the bottom of the viewport while the caret is in a paragraph. It slides away
// when focus leaves, so it costs nothing while the sidebar or the title is being
// filled in.
//
// Docked rather than rendered in the block, and rather than floating next to the
// selection, because of what this editor is for: paragraphs run long, and a bar
// that follows the selection sits ON the text being read - exactly where the eye
// is. At the bottom edge it is never in the way and never scrolls off, so the
// controls are in the same place for the first line of a block and the fortieth.
//
// The consequence is that nothing here is per-block: every button acts on
// activeRtEditor(), the editor the caret is in.
let rtDockEl = null;

function rtDock() {
  if (rtDockEl) return rtDockEl;
  // The bar is chrome for an editor, so a page with no editor must never grow
  // one. /terms.html loads this engine for the clause editor an admin gets, and
  // a READER of that page has no .rt-editor anywhere: without this guard the
  // first focusin or selectionchange - a click in the search well, a drag-select
  // over a clause - parents an unstyled #rt-dock to <body>, and with css/write.css
  // never linked for a reader it paints exactly where it lands: a row of bare
  // buttons and labels under the footer. #post-form counts as an editor because
  // write.html renders its blocks a moment after this file runs.
  if (!document.querySelector('.rt-editor') && !document.getElementById('post-form')) return null;
  rtDockEl = document.createElement('div');
  rtDockEl.id = 'rt-dock';
  rtDockEl.className = 'rt-dock';
  // aria-hidden as well as .is-open: while the bar is slid away it is not just
  // invisible but out of reach, and a screen reader should not offer 25 controls
  // that apply to no selection. inert would say the same thing in one word but
  // is not in Safari 15, which this site still supports.
  rtDockEl.setAttribute('aria-hidden', 'true');
  rtDockEl.innerHTML =
    `<div class="rt-dock-inner">
      <div class="rt-toolbar" role="toolbar" aria-label="Định dạng đoạn văn">${rtToolbarHtml()}</div>
    </div>`;
  document.body.appendChild(rtDockEl);
  return rtDockEl;
}

// Whether the bar belongs on screen. Deliberately NOT activeRtEditor(): that one
// falls back to the last saved selection so a command still has something to
// apply to while focus sits in an open menu, and it therefore keeps answering
// "yes" long after the author has clicked away into the title or the sidebar -
// the bar would never come down. Focus is the honest test: the toolbar belongs to
// the editor that HAS the caret, or to itself while one of its menus is open.
function rtDockShouldOpen() {
  if (rtMenuTrigger || rtTableTrigger || rtLinkOpen || rtImageUrlOpen) return true;
  const el = document.activeElement;
  if (!el || !el.closest) return false;
  return !!el.closest('.rt-editor') || !!el.closest('.rt-dock');
}

// Shown and hidden from ONE place, called by everything that can move the caret.
function syncRtDock() {
  const dock = rtDock();
  if (!dock) return; // no editor on this page: there is nothing to dock a bar to
  const open = rtDockShouldOpen();
  if (open === dock.classList.contains('is-open')) return;
  dock.classList.toggle('is-open', open);
  dock.setAttribute('aria-hidden', String(!open));
  // The page gets bottom padding equal to the bar's height while it is up, so the
  // last block can still be scrolled clear of it - a fixed bar otherwise covers
  // the end of the post, which is exactly where an author is typing.
  document.body.classList.toggle('rt-dock-open', open);
  // The dock's height is part of whether the image panel's step row fits below the
  // picture, so the panel re-decides which side of the picture it goes on whenever
  // the bar arrives or leaves. A no-op with no picture selected.
  placeRtImgPanel();
}

// ---- The toolbar's own state ------------------------------------------------
// Every button and trigger is re-read from the DOM around the caret rather than
// from a variable this code keeps: aria-pressed is the single source of truth for
// the styling (see .rt-btn[aria-pressed='true'] in write.html), and the only way
// it cannot drift from what the caret is actually sitting in is to ask.
// document.queryCommandState() answers for the character marks; the block classes
// are read off the block itself.
// The highlighter has no execCommand state to ask for - queryCommandState knows
// nothing about 'hiliteColor' - so the mark is read off the DOM: is the caret
// inside a .rt-mark. The editor is passed in so the search cannot escape the
// block, which matters because the menus are parented to <body>.
function rtMarkState(editor) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType !== 1) node = node.parentElement;
  if (!node || !node.closest || !editor.contains(node)) return false;
  const mark = node.closest('.rt-mark');
  return !!mark && editor.contains(mark);
}

// Called from everything that can move the caret or change a mark. It also raises
// and lowers the dock, so there is one entry point rather than two that could
// disagree about whether a paragraph is being edited.
function syncRtToolbars() {
  rtCachedSyncPass++;
  const editor = activeRtEditor();
  syncRtDock();
  for (const btn of document.querySelectorAll('.rt-btn[aria-pressed]')) {
    let on = false;
    // With no editor the buttons all read off: the dock is on its way down and
    // there is no selection any of them could describe.
    if (editor && btn.dataset.state === 'cmd') {
      try {
        on = document.queryCommandState(btn.dataset.cmd);
      } catch {
        on = false; // some engines throw for a command they do not support
      }
    } else if (editor && btn.dataset.state === 'mark') {
      on = rtMarkState(editor);
    } else if (editor && btn.dataset.state === 'link') {
      on = !!rtLinkAroundCaret(editor);
    } else if (editor && btn.dataset.state === 'quote') {
      // A quotation is a wrapper the caret is INSIDE, not a class on the block
      // it sits in: rtSelectedBlocks() returns the <p> inside the quotation,
      // which never carries the class itself. So this reads the ancestry, the way the
      // highlight and the link do, and not the block.
      on = !!rtQuoteAroundCaret(editor);
    } else if (editor && btn.dataset.state === 'klass') {
      // create:false - this runs on every selectionchange, and a read that
      // wrapped the caret's line in a <p> would edit the post as the caret moved.
      const target = rtSelectedBlocksCached(editor)[0];
      on = !!(target && target.classList.contains(btn.dataset.class));
    }
    btn.setAttribute('aria-pressed', String(on));
  }
  // The heading triggers still live in their own blocks and each reads its own
  // level, so every trigger on the page is synced - not just the dock's.
  for (const trigger of document.querySelectorAll('.rt-menu-trigger')) {
    syncRtTrigger(trigger, editor);
  }
}

// The value a trigger shows, and whether it is tinted as "not the default".
// The heading trigger is not about a selection at all - it reads the block's own
// level - so it never depends on where the caret is.
function rtTriggerValue(trigger, editor) {
  const name = trigger.dataset.menu;
  if (name === 'heading') {
    const block = findBlock(trigger.dataset.key);
    return block ? String(rtHeadingLevel(block)) : '';
  }
  if (name === 'layoutKind') {
    const block = findBlock(trigger.dataset.key);
    return block ? imageLayoutDef(block.layout).id : '';
  }
  // The other five triggers live in the docked toolbar and describe whichever
  // editor holds the caret; with none, they fall back to their own names.
  if (!editor) return '';
  const menu = RT_MENUS[name];
  // formatBlock writes a real h2/h3 (or hands the block back to <p>) rather
  // than a <font> ancestor, so the value in force is read off the caret's
  // nearest block-level ancestor instead of the <font> lookup every other
  // menu here shares below. Bounded by the editor for the same reason every
  // other closest() walk in this file is - the menu itself lives in <body>.
  if (name === 'headingFormat') {
    const sel = window.getSelection();
    let node = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
    if (node && node.nodeType !== 1) node = node.parentElement;
    if (!node || !node.closest || !editor.contains(node)) return '';
    const block = node.closest('h2, h3, p');
    if (!block || !editor.contains(block)) return '';
    const tag = block.tagName.toLowerCase();
    // 'p' is the neutral state every untouched paragraph is already in - not a
    // choice worth tinting the pill for, the same way an ordinary run with no
    // explicit <font size>/<font face> leaves the size/font pills untinted
    // below rather than showing as "Vừa"/"Mặc định" in force.
    return tag === 'p' ? '' : tag;
  }
  // "Chèn ảnh" lists things to DO at the caret, not values a paragraph can carry,
  // so there is nothing in force to read back. Without this the <font> lookup below
  // runs for it too, and a caret that happens to sit inside a size or a face would
  // tint the trigger with a value this menu never offered.
  if (menu.apply === 'action') return '';
  if (menu.apply === 'klass') {
    const target = rtSelectedBlocksCached(editor)[0];
    return (target && menu.group.find((c) => target.classList.contains(c))) || '';
  }
  // A <font> ancestor is what the size and font pickers write, so the value in
  // force is whatever the nearest one carries - matched against the menu's own
  // options so a pasted face or an odd size shows as "no choice" rather than as a
  // label this menu never offered.
  const sel = window.getSelection();
  let node = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
  if (node && node.nodeType !== 1) node = node.parentElement;
  // Bounded by the editor: closest() would otherwise walk out into the page, and
  // the menus themselves live in <body> carrying <font>-free specimen markup.
  if (!node || !node.closest || !editor.contains(node)) return '';
  const font = node.closest('font');
  if (!font || !editor.contains(font)) return '';
  const raw = menu.cmd === 'fontSize' ? font.getAttribute('size') : font.getAttribute('face');
  if (!raw) return '';
  if (menu.cmd === 'fontSize') return menu.options.some((o) => o.value === raw) ? raw : '';
  // "Georgia, serif" and "Georgia,'Times New Roman',serif" are one choice, so the
  // comparison is on the first family only - the same rule api.js applies.
  const face = firstFontFamily(raw);
  const hit = menu.options.find((o) => firstFontFamily(o.value) === face);
  return hit ? hit.value : '';
}

function syncRtTrigger(trigger, editor) {
  const value = rtTriggerValue(trigger, editor);
  const label = trigger.querySelector('.rt-select-value');
  if (label) label.textContent = trigger.dataset.menu === 'heading' ? `H${value || 2}` : rtMenuLabel(trigger.dataset.menu, value);
  trigger.dataset.value = value;
  // The heading trigger always carries a level, so it is never "off-default" -
  // tinting it would just be a permanent highlight.
  const isDefault = !value || trigger.dataset.menu === 'heading' || trigger.dataset.menu === 'layoutKind';
  trigger.dataset.active = String(!isDefault);
}

// ---- The menu ---------------------------------------------------------------
// ONE menu element for the whole page, built on first use and parented to
// <body>. Not one per toolbar, and not inside the toolbar: .glass-panel clips its
// own rounded corners and the sidebar column is position:sticky, so a menu
// rendered in place would be cut off at the panel's edge. Living outside both is
// also why it is position:fixed and has to be placed by hand - see placeRtMenu().
// Focus MOVES into the menu, which is what keeps the keyboard side small: the
// focused option IS the active one, so there is no aria-activedescendant to keep
// in sync and the highlight is plain :focus in the CSS.
let rtMenuEl = null;
let rtMenuTrigger = null;

// One option. The specimen IS the label, set in whatever the option sets - "Nét
// thanh" in Georgia, "Lớn" at 1.2em - which is the whole reason these are DOM
// elements rather than <option>s: an OS-drawn popup can only show words.
// The leadings are the exception: at one line 1.35 and 2.5 look identical, so
// those options show the number as the label and two real lines underneath it,
// set at the leading being named.
function rtMenuOption(opt, menu) {
  const isLeading = menu.group === RT_LH_CLASSES;
  const body = isLeading
    ? `<span class="rt-menu-sample-lead">${escapeHtml(opt.label)}</span>
       <span class="rt-menu-sample ${opt.value}">Một đoạn văn mẫu<br>ở mức giãn dòng này</span>`
    : `<span class="rt-menu-sample${opt.sample ? ' ' + opt.sample : ''}">${escapeHtml(opt.label)}</span>`;
  const hint = opt.hint ? `<span class="rt-menu-sample-hint">${escapeHtml(opt.hint)}</span>` : '';
  // An icon ahead of the label, for the one menu whose options are DESTINATIONS
  // rather than specimens ("Chèn ảnh"): there is no typeface or leading to set the
  // label in, so the icon is what tells "Tải ảnh lên" from "Từ thư viện" at a
  // glance. `.rt-menu-option > .material-symbols-outlined` in write.html already
  // sizes and colours a direct-child icon - the rule was written for this shape -
  // so it needs no CSS of its own. aria-hidden because the label says the same
  // thing in words, and the option's accessible name must stay the label.
  const icon = opt.icon ? `<span class="material-symbols-outlined" aria-hidden="true">${opt.icon}</span>` : '';
  // `data-default` marks the one option that is in force when the trigger has no
  // value of its own - "Vừa" for Cỡ chữ, 1.7 for Giãn dòng. openRtMenu() reads it
  // back. The two menus with no such option simply never set it: "Chèn ảnh", whose
  // choices are destinations rather than states, and "Cấp tiêu đề", whose trigger
  // always carries a level and so always has a value.
  const dflt = opt.isDefault ? ' data-default="1"' : '';
  return `<button type="button" role="option" tabindex="-1" aria-selected="false" data-value="${escapeHtml(opt.value)}"${dflt} class="rt-menu-option${isLeading ? ' rt-menu-option--lh' : ''}">
    ${icon}
    <span class="rt-menu-body">${body}${hint}</span>
    <span class="rt-menu-option-check material-symbols-outlined" aria-hidden="true">check</span>
  </button>`;
}

function rtMenu() {
  if (rtMenuEl) return rtMenuEl;
  rtMenuEl = document.createElement('div');
  rtMenuEl.id = 'rt-menu';
  rtMenuEl.className = 'rt-menu';
  rtMenuEl.setAttribute('role', 'listbox');
  rtMenuEl.hidden = true;

  rtMenuEl.addEventListener('click', (e) => {
    const opt = e.target.closest('.rt-menu-option');
    if (!opt || !rtMenuTrigger) return;
    applyRtMenuValue(rtMenuTrigger, opt.dataset.value);
  });

  rtMenuEl.addEventListener('keydown', (e) => {
    const opts = Array.from(rtMenuEl.querySelectorAll('.rt-menu-option'));
    const i = opts.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      opts[(i + step + opts.length) % opts.length].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? opts[0] : opts[opts.length - 1]).focus();
    } else if (e.key === 'Tab') {
      // Closes rather than moving on, for the same reason the options are
      // tabindex="-1": the menu sits at the end of <body>, so the next tab stop
      // from here is the end of the document, nowhere near the toolbar.
      e.preventDefault();
      closeRtMenu({ focusTrigger: true });
    }
  });

  document.body.appendChild(rtMenuEl);
  return rtMenuEl;
}

// Placed by hand because the menu is fixed-position in <body>: under the trigger
// by default, flipped above it when the viewport has no room below, and pulled
// back inside the right edge on a narrow screen. Measuring needs the menu
// visible, so openRtMenu() unhides it before calling this.
function placeRtMenu() {
  if (!rtMenuTrigger || !rtMenuEl) return;
  const GAP = 6;
  const EDGE = 8;
  const t = rtMenuTrigger.getBoundingClientRect();
  const m = rtMenuEl.getBoundingClientRect();
  let top = t.bottom + GAP;
  if (top + m.height > window.innerHeight - EDGE && t.top - GAP - m.height > EDGE) {
    top = t.top - GAP - m.height;
  }
  const left = Math.max(EDGE, Math.min(t.left, window.innerWidth - m.width - EDGE));
  rtMenuEl.style.top = `${Math.round(top)}px`;
  rtMenuEl.style.left = `${Math.round(left)}px`;
}

function openRtMenu(trigger) {
  const menu = rtMenu();
  const name = trigger.dataset.menu;
  const spec = RT_MENUS[name];
  rtMenuTrigger = trigger;
  // The group heading the menu carries ("CỠ CHỮ", "GIÃN DÒNG") is aria-hidden and
  // repeated as the listbox's own label: a role="listbox" may only contain
  // options, so the heading cannot be announced as part of the list.
  menu.setAttribute('aria-label', spec.title);
  menu.innerHTML =
    `<div class="rt-menu-title" aria-hidden="true">${escapeHtml(spec.title)}</div>` +
    spec.options.map((o) => rtMenuOption(o, spec)).join('');
  const current = trigger.dataset.value || '';
  const opts = Array.from(menu.querySelectorAll('.rt-menu-option'));
  // No value in force is NOT the same as no value selected. A paragraph that has
  // never been through this menu is still at the menu's own default step - "Vừa"
  // for Cỡ chữ, 1.7 for Giãn dòng, "Vừa" for Khoảng cách đoạn - so that is the
  // option the listbox reports and the one the arrow keys start from. Leaving
  // nothing selected handed the choice to the `|| opts[0]` below, and opts[0] for
  // Cỡ chữ is "Nhỏ": the menu opened highlighted on a size the paragraph does not
  // have, which reads as the default being small. A menu with no isDefault option
  // gets fallback === undefined, so every option stays unselected as it was.
  const fallback = opts.find((o) => o.dataset.default === '1');
  opts.forEach((opt) => opt.setAttribute(
    'aria-selected',
    String(current ? opt.dataset.value === current : opt === fallback),
  ));
  // The layout picker is a full-width field: its list opens at the field's own
  // width instead of the toolbar pills' narrow default.
  menu.style.minWidth = name === 'layoutKind' ? `${Math.min(trigger.offsetWidth, window.innerWidth - 16)}px` : '';
  menu.style.maxWidth = name === 'layoutKind' ? 'calc(100vw - 1rem)' : '';
  menu.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  placeRtMenu();
  // Opens on the value already in force, so the arrow keys start from where the
  // paragraph actually is rather than from the top of the list.
  (menu.querySelector('[aria-selected="true"]') || opts[0]).focus();
}

function closeRtMenu({ focusTrigger = false } = {}) {
  if (!rtMenuTrigger) return;
  const trigger = rtMenuTrigger;
  rtMenuTrigger = null;
  rtMenuEl.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  // Focus goes back to the trigger rather than being dropped on <body>, so a
  // keyboard user who closes the menu keeps their place in the toolbar.
  if (focusTrigger && document.contains(trigger)) trigger.focus();
}

// A heading, converted directly to a <p> holding the same children - see the
// comment at applyRtMenuValue's "Đoạn văn thường" branch for why this exists
// instead of execCommand('formatBlock', false, 'p').
function rtHeadingToParagraph(h) {
  const p = document.createElement('p');
  while (h.firstChild) p.appendChild(h.firstChild);
  h.replaceWith(p);
  return p;
}

// A list item, converted to a <p> sitting between the list's own two halves -
// same reason as rtHeadingToParagraph above, but a list item additionally
// carries its PARENT list along, which a heading never has to worry about:
// removing item 2 out of a <ul>/<ol> of five does not remove the list, it
// splits it into "items 1" and "items 3-5", with the new paragraph between
// them. Removing the only item removes the (now-empty) list entirely, and
// removing the first or last item just shrinks it, with the paragraph
// landing before or after.
//
// The second half of a split ORDERED list gets a `start` continuing the
// first, for the same reason rtRenumberContinuedLists() does at the
// whole-block level (see that function's own comment): a reader expects
// "3." to still say 3 after the middle of a numbered list turns into a
// paragraph, not to restart at "1.".
function rtListItemToParagraph(li) {
  const list = li.parentElement;
  const isOrdered = list.tagName === 'OL';
  const items = [...list.children].filter((el) => el.tagName === 'LI');
  const idx = items.indexOf(li);
  const before = items.slice(0, idx);
  const after = items.slice(idx + 1);

  const p = document.createElement('p');
  while (li.firstChild) p.appendChild(li.firstChild);

  let afterList = null;
  if (after.length) {
    afterList = document.createElement(list.tagName);
    if (list.className) afterList.className = list.className;
    for (const item of after) afterList.appendChild(item); // moves each out of `list`
    if (isOrdered) {
      const baseStart = Number(list.getAttribute('start')) || 1;
      const newStart = baseStart + before.length + 1; // +1 for the removed item itself
      if (newStart !== 1) afterList.setAttribute('start', String(newStart));
    }
  }

  li.remove();
  list.after(p);
  if (afterList) p.after(afterList);
  if (!before.length) list.remove(); // nothing left in the first half

  return p;
}

function applyRtMenuValue(trigger, value) {
  const name = trigger.dataset.menu;
  const spec = RT_MENUS[name];

  // The heading level is a property of the BLOCK, not of a selection, so it is
  // written to the model and the block re-rendered - which is also what moves the
  // input to its new .rt-field--h* size.
  if (spec.apply === 'level') {
    const key = trigger.dataset.key;
    closeRtMenu();
    const block = findBlock(key);
    if (block) block.level = Number(value);
    renderBlocks();
    // Focus was inside the menu that just closed, and renderBlocks() has replaced
    // the trigger it belonged to - so it is put on the REBUILT trigger rather than
    // left on <body>, where the next Tab would start from the top of the page.
    document.querySelector(`.rt-menu-trigger[data-menu="heading"][data-key="${key}"]`)?.focus();
    return;
  }

  // The layout kind, likewise a property of the block: re-rendered because the
  // number of picture slots and the text box depend on it.
  if (spec.apply === 'layout') {
    const key = trigger.dataset.key;
    closeRtMenu();
    const block = findBlock(key);
    if (block) block.layout = value;
    renderBlocks();
    document.querySelector(`.rt-menu-trigger[data-menu="layoutKind"][data-key="${key}"]`)?.focus();
    return;
  }

  // Everything else needs the selection back: opening the menu moved focus into
  // it, which collapsed the range the command has to apply to.
  closeRtMenu();
  const editor = restoreRtSelection();
  if (!editor) return;
  if (spec.apply === 'action') {
    // "Chèn ảnh". The target is captured HERE, while the selection has just been
    // restored, and then handed off: everything an action does is a wait - a file
    // dialog, the picker modal, an upload - and the picture has to land where the
    // caret was, not wherever focus happens to be by the time it is ready.
    rtInsertImage(rtInsertTarget(editor), value);
    return;
  }
  if (spec.apply === 'klass') {
    rtApplyBlockClass(editor, value, spec.group);
  } else if (spec.cmd === 'formatBlock' && value === 'p') {
    // Not execCommand('formatBlock', false, 'p') here, unlike every other
    // value this menu can apply - feedback: picking "Đoạn văn thường" on a
    // heading, or on a bullet/numbered list item, visually looked like it
    // worked, but the save that followed still stored the original
    // <h2>/<h3> or <li>. formatBlock's behaviour DEMOTING a heading or a
    // list item down to a plain paragraph is one of the least consistent
    // corners of execCommand across engines - some silently no-op instead of
    // converting, which is indistinguishable from success by the return
    // value this code was trusting. Converting the element directly removes
    // the browser from that decision: every heading/list item the selection
    // touches becomes a <p> holding the same children, unconditionally.
    const targets = rtSelectedBlocks(editor).filter((el) => /^H[1-6]$/.test(el.tagName) || el.tagName === 'LI');
    let firstP = null;
    for (const el of targets) {
      const p = el.tagName === 'LI' ? rtListItemToParagraph(el) : rtHeadingToParagraph(el);
      if (!firstP) firstP = p;
    }
    // A block that was already a <p> (or a blockquote/td) has nothing to
    // convert - formatBlock still runs for those, exactly as before.
    if (!targets.length) document.execCommand(spec.cmd, false, value);
    else rtCaretToCell(firstP);
  } else {
    document.execCommand(spec.cmd, false, value);
  }
  syncEditorToBlock(editor);
  saveRtSelection(editor);
  syncRtToolbars();
}

// A click that is neither on a trigger nor inside the menu closes it. The
// trigger's own click is handled by the delegated listener below, which toggles.
document.addEventListener('click', (e) => {
  if (!rtMenuTrigger) return;
  if (e.target.closest('.rt-menu-trigger') || e.target.closest('.rt-menu')) return;
  closeRtMenu();
});
// The same rule for the table picker: a click that is neither on its pill nor
// inside the pop closes it. The pop's own clicks are handled by the listener on
// the pop, which inserts a table or runs an operation.
document.addEventListener('click', (e) => {
  if (!rtTableTrigger) return;
  if (e.target.closest('.rt-table-trigger') || e.target.closest('.rt-table-pop')) return;
  closeRtTable();
});
// Escape from anywhere: the menu's own handler only sees the key while focus is
// inside it, and a click elsewhere can move focus out without closing.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeRtMenu({ focusTrigger: true });
  closeRtTable({ focusTrigger: true });
});

// The menu is fixed while the page underneath it scrolls, so it is re-placed on
// every scroll - and let go of once the trigger has left the screen, rather than
// left floating over unrelated content. Capture phase, because the scroll may
// come from a nested overflow container and scroll events do not bubble.
// rAF-throttled, so a fast scroll costs one placement per frame.
let rtMenuPlacePending = false;
function repositionRtMenu() {
  if (!rtMenuTrigger || rtMenuPlacePending) return;
  rtMenuPlacePending = true;
  requestAnimationFrame(() => {
    rtMenuPlacePending = false;
    if (!rtMenuTrigger) return;
    const r = rtMenuTrigger.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) {
      closeRtMenu();
      return;
    }
    placeRtMenu();
  });
}
window.addEventListener('scroll', repositionRtMenu, true);
window.addEventListener('resize', repositionRtMenu);

// ---- The table picker ---------------------------------------------------------
// Word's way of making a table: a grid to sweep the pointer over - ten across,
// eight down - where the lit rectangle IS the table you are about to get and the
// line under it counts it ("4 × 3"). A click (or Enter on the lit cell) inserts
// that table at the caret: a header row of <th> over plain <td> rows, every cell
// holding a <br> so an empty one still has a height and a caret target.
//
// The same pill is also the table's own toolbox: with the caret already inside a
// table, the operations under the grid add and remove rows and columns and take
// the whole table out - because a table nobody can extend is a table nobody can
// finish. They are disabled otherwise, rather than hidden, so the pill opens
// onto the same shape every time.
//
// The markup written into the paragraph carries no class and no style: the
// server's allowlist keeps table elements but validates classes against the
// rt-* families, and the shared rules in css/common.css style every table by
// element alone - so what the picker inserts and what a paste from Word brings
// render identically, here and on the reading page.
const RT_TABLE_COLS = 10;
const RT_TABLE_ROWS = 8;

// The operations under the grid, in roughly the order Word's own context menu
// reads them. `delete` is the one with no way back, which is what the error ink
// in write.html is for.
//
// Border and vertical-align are three explicit choices each rather than a
// toggle, the same way Word's own border dropdown lists "All borders" /
// "No border" / "Outside borders" as named options instead of a single
// on/off switch - there is no single "next" state that would make sense to
// cycle through. Border acts on the whole TABLE (rtTableAroundCaret's
// table); vertical align acts on the ONE cell the caret is in, the same
// scope every other op here already uses (row-delete deletes the caret's
// row, not a multi-row selection) - table cell RANGE selection is exactly
// the kind of cross-browser inconsistency this editor has avoided building
// on anywhere else.
const RT_TABLE_OPS = [
  { op: 'row-above', label: 'Thêm hàng phía trên' },
  { op: 'row-below', label: 'Thêm hàng phía dưới' },
  { op: 'col-left', label: 'Thêm cột phía trái' },
  { op: 'col-right', label: 'Thêm cột phía phải' },
  { op: 'row-delete', label: 'Xoá hàng' },
  { op: 'col-delete', label: 'Xoá cột' },
  { op: 'border-all', label: 'Viền: tất cả' },
  { op: 'border-outer', label: 'Viền: chỉ viền ngoài' },
  { op: 'border-none', label: 'Viền: không viền' },
  { op: 'valign-top', label: 'Căn chữ: trên ô' },
  { op: 'valign-middle', label: 'Căn chữ: giữa ô' },
  { op: 'valign-bottom', label: 'Căn chữ: dưới ô' },
  { op: 'delete', label: 'Xoá bảng' },
];

// Table-level border classes - mutually exclusive, "all" (the CSS default,
// see .rt-editor table in common.css) needs no class of its own, only
// something to remove when switching AWAY from it.
const RT_TABLE_BORDER_CLASSES = ['rt-tbl-border-outer', 'rt-tbl-border-none'];
// Per-cell vertical align - "top" is likewise the CSS default and carries no
// class.
const RT_VALIGN_CLASSES = ['rt-valign-middle', 'rt-valign-bottom'];

let rtTableEl = null;
let rtTableTrigger = null;

// The table itself. One header row of <th scope="col"> - Word's own default
// grid dresses its first row as a heading - over rows-1 body rows, every cell a
// <br> so it takes a click before anything is typed into it.
function rtTableHtml(rows, cols) {
  const cell = (tag) => `<${tag}${tag === 'th' ? ' scope="col"' : ''}><br></${tag}>`;
  const row = (tag) => `<tr>${Array.from({ length: cols }, () => cell(tag)).join('')}</tr>`;
  return `<table><thead>${row('th')}</thead><tbody>${
    Array.from({ length: Math.max(rows - 1, 0) }, () => row('td')).join('')
  }</tbody></table>`;
}

// A new cell for an existing row: a <th> where the row is a head row, a <td>
// everywhere else, so adding a column to a table with a heading keeps the
// heading a heading.
function rtTableNewCell(row) {
  const tag = row.closest('thead') ? 'th' : 'td';
  const cell = document.createElement(tag);
  if (tag === 'th') cell.setAttribute('scope', 'col');
  cell.appendChild(document.createElement('br'));
  return cell;
}

function rtTableColCount(table) {
  return table.rows.length ? table.rows[0].cells.length : 1;
}

// table.insertRow() puts the new row in the section the reference row lives in
// (a row added above the heading stays up in <thead> with it), so the section
// is never this code's business - only the cells are, because insertRow's own
// row comes back empty and an empty row has no height.
function rtTableAddRow(table, where, row) {
  // Counted BEFORE the insert: a row added above the first one becomes rows[0]
  // itself, and reading the width off rows[0] after the insert would read the
  // new, still empty row and build it no cells at all.
  const cols = rtTableColCount(table);
  const idx = where === 'above' ? row.rowIndex : row.rowIndex + 1;
  const added = table.insertRow(idx);
  for (let i = 0; i < cols; i++) {
    added.appendChild(rtTableNewCell(added));
  }
  return added;
}

// One cell per row at the same offset. A row shorter than the offset (a colspan
// in a paste) gets the cell appended rather than skipped, so no row ends up
// narrower than the rest.
function rtTableAddCol(table, where, cell) {
  // Custom column widths (rtTableResize below) describe the old column set.
  table.querySelector(':scope > colgroup')?.remove();
  const idx = where === 'left' ? cell.cellIndex : cell.cellIndex + 1;
  let added = null;
  for (const row of table.rows) {
    const nc = rtTableNewCell(row);
    if (idx < row.cells.length) row.insertBefore(nc, row.cells[idx]);
    else row.appendChild(nc);
    if (row === cell.parentElement) added = nc;
  }
  return added;
}

// The last row going takes the table with it: an empty <table> renders nothing
// the reader can see and nothing the author can click into. Same for the last
// column. Both report whether the table survived, though no caller needs it
// yet beyond the tests.
function rtTableDeleteRow(table, row) {
  if (table.rows.length === 1) {
    table.remove();
    return false;
  }
  table.deleteRow(row.rowIndex);
  return true;
}

function rtTableDeleteCol(table, index) {
  if (rtTableColCount(table) === 1) {
    table.remove();
    return false;
  }
  table.querySelector(':scope > colgroup')?.remove();
  for (const row of table.rows) if (row.cells[index]) row.deleteCell(index);
  return true;
}

// ---- Resizing a table's columns and rows (admins only) ----
// Drag the right edge of a cell to move the boundary between two columns, or
// the bottom edge of a row to change its height. Double-click an edge to put
// it back (equal columns / automatic height). Column widths are stored as
// percentages on a <colgroup> so the table still fits any screen; row heights
// as px on the <tr>. server/sanitize-html.js allows exactly these two.
const RT_RESIZE_HIT = 5; // px either side of an edge that grabs it
const RT_COL_MIN = 5; // % a column can shrink to
let rtResize = null; // the drag in progress

function rtResizeAllowed() {
  const user = typeof Auth !== 'undefined' ? Auth.getUser() : null;
  return !!(user && user.role === 'admin');
}

// What edge, if any, the pointer is on: { kind: 'col', table, index } for the
// boundary after column `index`, or { kind: 'row', table, row }.
function rtResizeHit(e) {
  const cell = e.target.closest && e.target.closest('td, th');
  const table = cell && cell.closest('table');
  if (!table || !table.closest('.rt-editor')) return null;
  const r = cell.getBoundingClientRect();
  if (Math.abs(e.clientX - r.right) <= RT_RESIZE_HIT && cell.cellIndex < cell.parentElement.cells.length - 1 && cell.colSpan === 1) {
    return { kind: 'col', table, index: cell.cellIndex };
  }
  if (Math.abs(e.clientY - r.bottom) <= RT_RESIZE_HIT) return { kind: 'row', table, row: cell.parentElement };
  return null;
}

// The table's <colgroup>, created from the columns' current rendered widths
// the first time a boundary is dragged (or rebuilt if the column count moved).
function rtTableCols(table) {
  const n = rtTableColCount(table);
  let group = table.querySelector(':scope > colgroup');
  if (group && group.children.length === n) return [...group.children];
  group?.remove();
  const total = table.getBoundingClientRect().width || 1;
  const model = [...table.rows].find((row) => row.cells.length === n && [...row.cells].every((c) => c.colSpan === 1));
  group = document.createElement('colgroup');
  for (let i = 0; i < n; i += 1) {
    const col = document.createElement('col');
    const w = model ? (model.cells[i].getBoundingClientRect().width / total) * 100 : 100 / n;
    col.style.width = `${Math.max(RT_COL_MIN, w).toFixed(2)}%`;
    group.appendChild(col);
  }
  table.insertBefore(group, table.firstChild);
  return [...group.children];
}

function rtResizeCommit(table) {
  const editor = table.closest('.rt-editor');
  // Through the editor's own input path, so the block model, the word count
  // and autosave all see the change exactly as they see typing.
  if (editor) editor.dispatchEvent(new Event('input', { bubbles: true }));
}

document.addEventListener('pointermove', (e) => {
  if (rtResize) {
    const d = rtResize;
    if (d.kind === 'col') {
      const pair = d.startLeft + d.startRight;
      const left = Math.min(Math.max(d.startLeft + ((e.clientX - d.startX) / d.tableWidth) * 100, RT_COL_MIN), pair - RT_COL_MIN);
      d.cols[d.index].style.width = `${left.toFixed(2)}%`;
      d.cols[d.index + 1].style.width = `${(pair - left).toFixed(2)}%`;
    } else {
      d.row.style.height = `${Math.round(Math.min(Math.max(d.startHeight + e.clientY - d.startY, 24), 600))}px`;
    }
    return;
  }
  if (e.pointerType === 'touch') return;
  const table = e.target.closest && e.target.closest('.rt-editor table');
  if (!table) return;
  const hit = rtResizeAllowed() ? rtResizeHit(e) : null;
  if (hit) table.dataset.rtResize = hit.kind;
  else delete table.dataset.rtResize;
});

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !rtResizeAllowed()) return;
  const hit = rtResizeHit(e);
  if (!hit) return;
  e.preventDefault(); // no caret move, no text selection while dragging
  if (hit.kind === 'col') {
    const cols = rtTableCols(hit.table);
    rtResize = {
      kind: 'col',
      table: hit.table,
      index: hit.index,
      cols,
      startX: e.clientX,
      tableWidth: hit.table.getBoundingClientRect().width || 1,
      startLeft: parseFloat(cols[hit.index].style.width) || 0,
      startRight: parseFloat(cols[hit.index + 1].style.width) || 0,
    };
  } else {
    rtResize = { kind: 'row', table: hit.table, row: hit.row, startY: e.clientY, startHeight: hit.row.getBoundingClientRect().height };
  }
  document.body.classList.add('rt-resizing', `rt-resizing--${hit.kind}`);
}, true);

document.addEventListener('pointerup', () => {
  if (!rtResize) return;
  const { table } = rtResize;
  rtResize = null;
  document.body.classList.remove('rt-resizing', 'rt-resizing--col', 'rt-resizing--row');
  rtResizeCommit(table);
});

document.addEventListener('dblclick', (e) => {
  if (!rtResizeAllowed()) return;
  const hit = rtResizeHit(e);
  if (!hit) return;
  e.preventDefault();
  if (hit.kind === 'col') hit.table.querySelector(':scope > colgroup')?.remove();
  else hit.row.style.removeProperty('height');
  if (hit.kind === 'row' && !hit.row.getAttribute('style')) hit.row.removeAttribute('style');
  rtResizeCommit(hit.table);
});

// The caret into a cell, at its start. selectNodeContents over a cell holding
// only a <br> collapses to the one place a keystroke can land.
function rtCaretToCell(cell) {
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// The table the caret sits in, or null. Bounded by the editor the way
// rtMarkState() bounds its mark: closest() would otherwise walk out of the
// paragraph and into whatever the page happens to hold.
function rtTableAroundCaret(editor) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType !== 1) node = node.parentElement;
  if (!node || !node.closest || !editor.contains(node)) return null;
  const cell = node.closest('td, th');
  return cell && editor.contains(cell) ? cell.closest('table') : null;
}

function rtTable() {
  if (rtTableEl) return rtTableEl;
  rtTableEl = document.createElement('div');
  rtTableEl.id = 'rt-table-pop';
  // .rt-menu is the shell - glass, border, shadow, the [hidden] guard - and
  // .rt-table-pop lifts its max-height and carries the grid.
  rtTableEl.className = 'rt-menu rt-table-pop';
  rtTableEl.setAttribute('role', 'dialog');
  rtTableEl.setAttribute('aria-label', 'Chèn bảng');
  rtTableEl.hidden = true;

  const cells = [];
  for (let r = 1; r <= RT_TABLE_ROWS; r++) {
    for (let c = 1; c <= RT_TABLE_COLS; c++) {
      cells.push(`<button type="button" class="rt-table-cell" tabindex="-1" data-r="${r}" data-c="${c}" aria-label="Bảng ${c} cột, ${r} hàng"></button>`);
    }
  }
  rtTableEl.innerHTML = `
    <div class="rt-menu-title" aria-hidden="true">Chèn bảng</div>
    <div class="rt-table-grid">${cells.join('')}</div>
    <div class="rt-table-size" aria-live="polite"></div>
    <div class="rt-table-edit">
      <div class="rt-menu-title" aria-hidden="true">Bảng dưới con trỏ</div>
      ${RT_TABLE_OPS.map((o) => `<button type="button" class="rt-table-op" tabindex="-1" data-op="${o.op}">${escapeHtml(o.label)}</button>`).join('')}
    </div>`;

  // Hover and the keyboard light the same rectangle because hover MOVES FOCUS:
  // one source of truth for what a click or an Enter will insert, and the size
  // line under the grid reads off it.
  rtTableEl.addEventListener('focusin', (e) => {
    const cell = e.target.closest('.rt-table-cell');
    if (cell) rtTableLight(cell);
  });
  rtTableEl.addEventListener('mouseover', (e) => {
    const cell = e.target.closest('.rt-table-cell');
    if (cell && cell !== document.activeElement) cell.focus({ preventScroll: true });
  });
  rtTableEl.addEventListener('click', (e) => {
    const cell = e.target.closest('.rt-table-cell');
    if (cell) {
      rtTableInsert(Number(cell.dataset.r), Number(cell.dataset.c));
      return;
    }
    const op = e.target.closest('.rt-table-op');
    if (op && !op.disabled) rtTableOp(op.dataset.op);
  });
  rtTableEl.addEventListener('keydown', (e) => {
    const cell = e.target.closest('.rt-table-cell');
    if (!cell) {
      // Out of the operations, Tab leaves the way the listbox menu's does: the
      // pop sits at the end of <body>, so the next stop is nowhere useful.
      if (e.key === 'Tab') {
        e.preventDefault();
        closeRtTable({ focusTrigger: true });
      }
      return;
    }
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: RT_TABLE_COLS, ArrowUp: -RT_TABLE_COLS }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const all = rtTableEl.querySelectorAll('.rt-table-cell');
    const i = (Number(cell.dataset.r) - 1) * RT_TABLE_COLS + (Number(cell.dataset.c) - 1);
    all[Math.min(Math.max(i + step, 0), all.length - 1)].focus();
  });

  document.body.appendChild(rtTableEl);
  return rtTableEl;
}

// Light the rectangle from the top-left corner to this cell, and count it.
function rtTableLight(cell) {
  const r = Number(cell.dataset.r);
  const c = Number(cell.dataset.c);
  for (const other of rtTableEl.querySelectorAll('.rt-table-cell')) {
    other.classList.toggle('is-lit', Number(other.dataset.r) <= r && Number(other.dataset.c) <= c);
  }
  rtTableEl.querySelector('.rt-table-size').textContent = `${c} × ${r}`;
}

// Placed by hand for the same reason the listbox menu is: fixed in <body>, under
// the trigger, flipped above it when the viewport has no room below - which for
// a pill in the docked bar at the bottom of the screen is nearly always.
function placeRtTable() {
  if (!rtTableTrigger || !rtTableEl) return;
  const GAP = 6;
  const EDGE = 8;
  const t = rtTableTrigger.getBoundingClientRect();
  const m = rtTableEl.getBoundingClientRect();
  let top = t.bottom + GAP;
  if (top + m.height > window.innerHeight - EDGE && t.top - GAP - m.height > EDGE) {
    top = t.top - GAP - m.height;
  }
  const left = Math.max(EDGE, Math.min(t.left, window.innerWidth - m.width - EDGE));
  rtTableEl.style.top = `${Math.round(top)}px`;
  rtTableEl.style.left = `${Math.round(left)}px`;
}

function openRtTable(trigger) {
  const pop = rtTable();
  rtTableTrigger = trigger;
  // The operations describe the table under the caret, so they are only live
  // while there is one. restoreRtSelection() rather than the live selection:
  // focus has already moved to the pill, and with it the range the question
  // ("is the caret in a table?") needs.
  const editor = restoreRtSelection();
  const inTable = !!editor && !!rtTableAroundCaret(editor);
  for (const btn of pop.querySelectorAll('.rt-table-op')) btn.disabled = !inTable;
  pop.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  placeRtTable();
  // Opens on the smallest table rather than on nothing, so Enter straight after
  // opening inserts a 1 × 1 and the arrow keys have somewhere to start.
  const first = pop.querySelector('.rt-table-cell');
  rtTableLight(first);
  first.focus({ preventScroll: true });
}

function closeRtTable({ focusTrigger = false } = {}) {
  if (!rtTableTrigger) return;
  const trigger = rtTableTrigger;
  rtTableTrigger = null;
  rtTableEl.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  // Focus goes back to the pill rather than being dropped on <body>, so a
  // keyboard user who closes the picker keeps their place in the toolbar.
  if (focusTrigger && document.contains(trigger)) trigger.focus();
}

// Insert at the caret, through the same door every other insertion uses:
// execCommand('insertHTML') inside rtInsertAtTarget(), so the table lands on
// the browser's own undo stack the way a pasted picture does.
function rtTableInsert(rows, cols) {
  closeRtTable();
  const editor = restoreRtSelection();
  if (!editor) return;
  rtInsertAtTarget(rtInsertTarget(editor), rtTableHtml(rows, cols));
  syncRtToolbars();
}

// The operations under the grid. Each one ends by writing the editor back into
// the block model and re-saving the selection, exactly like a toolbar press -
// the table is paragraph content and the paragraph is the source of truth.
function rtTableOp(op) {
  closeRtTable();
  const editor = restoreRtSelection();
  if (!editor) return;
  const table = rtTableAroundCaret(editor);
  if (!table) return;
  const sel = window.getSelection();
  let node = sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
  if (node && node.nodeType !== 1) node = node.parentElement;
  const cell = node && node.closest ? node.closest('td, th') : null;
  if (!cell || !table.contains(cell)) return;
  const row = cell.parentElement;
  let caret = null;

  if (op === 'row-above' || op === 'row-below') {
    const added = rtTableAddRow(table, op === 'row-above' ? 'above' : 'below', row);
    caret = added.cells[Math.min(cell.cellIndex, added.cells.length - 1)];
  } else if (op === 'col-left' || op === 'col-right') {
    caret = rtTableAddCol(table, op === 'col-left' ? 'left' : 'right', cell);
  } else if (op === 'row-delete') {
    rtTableDeleteRow(table, row);
  } else if (op === 'col-delete') {
    rtTableDeleteCol(table, cell.cellIndex);
  } else if (op === 'delete') {
    table.remove();
  } else if (op.startsWith('border-')) {
    // 'all' is every class in the group OFF - the table falls back to
    // common.css's own default (hairline on every cell), the same "no class
    // is a real state" the alignment/line-height groups already rely on.
    table.classList.remove(...RT_TABLE_BORDER_CLASSES);
    if (op === 'border-outer') table.classList.add('rt-tbl-border-outer');
    else if (op === 'border-none') table.classList.add('rt-tbl-border-none');
    caret = cell;
  } else if (op.startsWith('valign-')) {
    cell.classList.remove(...RT_VALIGN_CLASSES);
    if (op === 'valign-middle') cell.classList.add('rt-valign-middle');
    else if (op === 'valign-bottom') cell.classList.add('rt-valign-bottom');
    caret = cell;
  }

  if (caret && document.contains(caret)) {
    editor.focus();
    rtCaretToCell(caret);
  }
  syncEditorToBlock(editor);
  saveRtSelection(editor);
  syncRtToolbars();
}

// ---- Table properties bar ----
// A floating bar over whichever table the caret is in - one the "Bảng" picker
// made or one pasted from Word, Docs, Excel or a web page alike. It carries the
// picker's row/column operations plus the table's own properties: header
// row/column, borders, stripes, padding, width, cell alignment, and "Làm sạch"
// to drop what the source brought along (its widths, colours, fonts). Every
// property is a class (rt-*), never an inline style, so both themes and the
// server sanitizer (CLASS_RE) treat it like the existing border classes.
const RT_TBL_TALIGN_CLASSES = ['rt-talign-center', 'rt-talign-right'];
const RT_TBL_BAR_GROUPS = [
  { label: 'Hàng', items: [
    { op: 'row-above', text: '+ Trên', title: 'Thêm hàng phía trên' },
    { op: 'row-below', text: '+ Dưới', title: 'Thêm hàng phía dưới' },
    { op: 'row-delete', text: 'Xoá', title: 'Xoá hàng', danger: true },
  ] },
  { label: 'Cột', items: [
    { op: 'col-left', text: '+ Trái', title: 'Thêm cột bên trái' },
    { op: 'col-right', text: '+ Phải', title: 'Thêm cột bên phải' },
    { op: 'col-delete', text: 'Xoá', title: 'Xoá cột', danger: true },
  ] },
  { label: 'Tiêu đề', items: [
    { op: 'head-row', text: 'Hàng đầu', title: 'Hàng đầu là hàng tiêu đề', toggle: true },
    { op: 'head-col', text: 'Cột đầu', title: 'Cột đầu là cột tiêu đề', toggle: true },
  ] },
  { label: 'Viền', items: [
    { op: 'border-all', text: 'Tất cả', title: 'Viền mọi ô', radio: 'border' },
    { op: 'border-outer', text: 'Ngoài', title: 'Chỉ viền ngoài', radio: 'border' },
    { op: 'border-none', text: 'Không', title: 'Không viền', radio: 'border' },
  ] },
  { label: 'Kiểu', items: [
    { op: 'striped', text: 'Kẻ sọc', title: 'Tô nền xen kẽ các hàng', toggle: true },
    { op: 'compact', text: 'Gọn', title: 'Thu nhỏ khoảng đệm trong ô', toggle: true },
    { op: 'fit', text: 'Vừa chữ', title: 'Bảng chỉ rộng bằng nội dung (mặc định: rộng hết khung)', toggle: true },
  ] },
  { label: 'Căn ô', items: [
    { op: 'talign-left', text: 'Trái', title: 'Căn chữ trái (ô đang chọn)', radio: 'talign' },
    { op: 'talign-center', text: 'Giữa', title: 'Căn chữ giữa (ô đang chọn)', radio: 'talign' },
    { op: 'talign-right', text: 'Phải', title: 'Căn chữ phải (ô đang chọn)', radio: 'talign' },
    { op: 'valign-top', text: '↑', title: 'Chữ sát trên ô', radio: 'valign' },
    { op: 'valign-middle', text: '↕', title: 'Chữ giữa ô theo chiều dọc', radio: 'valign' },
    { op: 'valign-bottom', text: '↓', title: 'Chữ sát dưới ô', radio: 'valign' },
  ] },
  { label: '', items: [
    { op: 'clean', text: 'Làm sạch', title: 'Bỏ độ rộng, màu, phông chữ… mang theo từ nguồn dán' },
    { op: 'delete', text: 'Xoá bảng', title: 'Xoá cả bảng', danger: true },
  ] },
];
let rtTblBar = null;
let rtTblBarTable = null;

function rtTblBarEl() {
  if (rtTblBar) return rtTblBar;
  rtTblBar = document.createElement('div');
  rtTblBar.className = 'rt-tblbar';
  rtTblBar.setAttribute('role', 'toolbar');
  rtTblBar.setAttribute('aria-label', 'Thuộc tính bảng');
  rtTblBar.hidden = true;
  rtTblBar.innerHTML = RT_TBL_BAR_GROUPS.map((g) => `<div class="rt-tblbar-group">${
    g.label ? `<span class="rt-tblbar-label">${escapeHtml(g.label)}</span>` : ''
  }${g.items.map((it) => `<button type="button" class="rt-tblbar-btn${it.danger ? ' is-danger' : ''}" data-op="${it.op}" title="${escapeHtml(it.title)}"${
    it.toggle || it.radio ? ' aria-pressed="false"' : ''
  }>${escapeHtml(it.text)}</button>`).join('')}</div>`).join('');
  // mousedown, not click: the caret has to stay in the cell the op acts on.
  rtTblBar.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const btn = e.target.closest('.rt-tblbar-btn');
    if (btn) rtTblBarOp(btn.dataset.op);
  });
  document.body.appendChild(rtTblBar);
  return rtTblBar;
}

// The table and cell under the live selection, inside an editor.
function rtTblBarContext() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let node = sel.getRangeAt(0).startContainer;
  if (node && node.nodeType !== 1) node = node.parentElement;
  const cell = node && node.closest ? node.closest('td, th') : null;
  const editor = cell && cell.closest('.rt-editor');
  if (!editor) return null;
  return { editor, table: cell.closest('table'), cell, range: sel.getRangeAt(0) };
}

// Cells the selection touches (a drag across several), else just the caret's.
function rtTblSelectedCells(ctx) {
  const all = [...ctx.table.querySelectorAll('td, th')].filter((c) => c.closest('table') === ctx.table);
  const hit = ctx.range.collapsed ? [] : all.filter((c) => ctx.range.intersectsNode(c));
  return hit.length ? hit : [ctx.cell];
}

function rtTblHasHeadRow(table) {
  const first = table.rows[0];
  return !!first && [...first.cells].every((c) => c.tagName === 'TH');
}

// Header row on: the first row's cells become <th scope="col"> inside a
// <thead>. Off: back to <td> in the body. Bold the source used for its
// heading stays as the author's text.
function rtTblSetHeadRow(table, on) {
  const first = table.rows[0];
  if (!first) return;
  for (const c of [...first.cells]) {
    const want = on ? 'TH' : 'TD';
    if (c.tagName === want) continue;
    const n = document.createElement(want.toLowerCase());
    for (const a of c.attributes) if (a.name !== 'scope') n.setAttribute(a.name, a.value);
    if (on) n.setAttribute('scope', 'col');
    while (c.firstChild) n.appendChild(c.firstChild);
    c.replaceWith(n);
  }
  if (on && first.parentElement.tagName !== 'THEAD') {
    let thead = table.tHead;
    if (!thead) thead = table.createTHead();
    thead.appendChild(first);
  } else if (!on && first.parentElement.tagName === 'THEAD') {
    let tbody = table.tBodies[0];
    if (!tbody) tbody = table.createTBody();
    tbody.insertBefore(first, tbody.firstChild);
    if (!table.tHead.rows.length) table.tHead.remove();
  }
}

// What a paste brings along that the article does not want on the table
// itself: fixed widths and heights, background colours, legacy border/align
// attributes, the source's own class names. Only the table's STRUCTURE
// (table, rows, cells, col) is touched - the text inside the cells, with its
// bold/italic/links (Google Docs carries bold as a styled <span>), is left to
// the usual paste passes. Merged cells (colspan/rowspan) and our own rt-*
// classes stay.
const RT_TBL_STRUCT = new Set(['TABLE', 'CAPTION', 'COLGROUP', 'COL', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH']);
const RT_TBL_DROP_ATTRS = ['style', 'width', 'height', 'bgcolor', 'background', 'align', 'valign', 'border', 'cellpadding', 'cellspacing', 'frame', 'rules', 'id'];
function rtTblClean(table) {
  table.querySelector(':scope > colgroup')?.remove();
  for (const el of [table, ...table.querySelectorAll('*')]) {
    if (!RT_TBL_STRUCT.has(el.tagName)) continue;
    for (const a of RT_TBL_DROP_ATTRS) el.removeAttribute(a);
    if (el.classList.length) {
      const keep = [...el.classList].filter((c) => /^rt-/.test(c));
      if (keep.length) el.className = keep.join(' ');
      else el.removeAttribute('class');
    }
  }
}

function rtTblBarOp(op) {
  const ctx = rtTblBarContext();
  if (!ctx) return;
  const { editor, table, cell } = ctx;
  const row = cell.parentElement;
  let caret = cell;
  if (op === 'row-above' || op === 'row-below') {
    const added = rtTableAddRow(table, op === 'row-above' ? 'above' : 'below', row);
    caret = added.cells[Math.min(cell.cellIndex, added.cells.length - 1)];
  } else if (op === 'col-left' || op === 'col-right') {
    caret = rtTableAddCol(table, op === 'col-left' ? 'left' : 'right', cell);
  } else if (op === 'row-delete') {
    const next = table.rows[row.rowIndex + 1] || table.rows[row.rowIndex - 1];
    rtTableDeleteRow(table, row);
    caret = next ? next.cells[Math.min(cell.cellIndex, next.cells.length - 1)] : null;
  } else if (op === 'col-delete') {
    const idx = cell.cellIndex;
    rtTableDeleteCol(table, idx);
    caret = document.contains(table) ? row.cells[Math.min(idx, row.cells.length - 1)] : null;
  } else if (op === 'delete') {
    table.remove();
    caret = null;
  } else if (op === 'head-row') {
    rtTblSetHeadRow(table, !rtTblHasHeadRow(table));
    caret = table.rows[row.rowIndex]?.cells[cell.cellIndex] || null;
  } else if (op === 'head-col') {
    table.classList.toggle('rt-tbl-headcol');
  } else if (op.startsWith('border-')) {
    table.classList.remove(...RT_TABLE_BORDER_CLASSES);
    if (op === 'border-outer') table.classList.add('rt-tbl-border-outer');
    else if (op === 'border-none') table.classList.add('rt-tbl-border-none');
  } else if (op === 'striped' || op === 'compact' || op === 'fit') {
    table.classList.toggle(`rt-tbl-${op}`);
  } else if (op.startsWith('talign-') || op.startsWith('valign-')) {
    const v = op.startsWith('valign-');
    const group = v ? RT_VALIGN_CLASSES : RT_TBL_TALIGN_CLASSES;
    const cls = `rt-${op}`;
    for (const c of rtTblSelectedCells(ctx)) {
      c.classList.remove(...group);
      if (group.includes(cls)) c.classList.add(cls);
      if (!c.classList.length) c.removeAttribute('class');
    }
  } else if (op === 'clean') {
    rtTblClean(table);
  }
  if (!table.classList.length) table.removeAttribute('class');
  // Structural ops moved or rebuilt cells, so the caret is put back explicitly;
  // property ops leave the selection where the author made it.
  const STRUCTURAL = ['row-above', 'row-below', 'col-left', 'col-right', 'row-delete', 'col-delete', 'head-row'];
  if (STRUCTURAL.includes(op) && caret && document.contains(caret)) rtCaretToCell(caret);
  syncEditorToBlock(editor);
  saveRtSelection(editor);
  syncRtToolbars();
  if (typeof scheduleLivePreview === 'function') scheduleLivePreview();
  rtTblBarSync();
}

// Shows the bar over the caret's table, reflecting its current state; hides it
// otherwise. Placed above the table, or pinned under the sticky "Thêm khối"
// bar while the table's top has scrolled past it.
function rtTblBarSync() {
  const ctx = rtTblBarContext();
  const bar = rtTblBarEl();
  if (!ctx || !document.contains(ctx.table)) {
    bar.hidden = true;
    rtTblBarTable = null;
    return;
  }
  const { table, cell } = ctx;
  rtTblBarTable = table;
  const has = (c) => table.classList.contains(c);
  const border = has('rt-tbl-border-none') ? 'border-none' : has('rt-tbl-border-outer') ? 'border-outer' : 'border-all';
  const talign = cell.classList.contains('rt-talign-center') ? 'talign-center' : cell.classList.contains('rt-talign-right') ? 'talign-right' : 'talign-left';
  const valign = cell.classList.contains('rt-valign-middle') ? 'valign-middle' : cell.classList.contains('rt-valign-bottom') ? 'valign-bottom' : 'valign-top';
  const on = {
    'head-row': rtTblHasHeadRow(table),
    'head-col': has('rt-tbl-headcol'),
    striped: has('rt-tbl-striped'),
    compact: has('rt-tbl-compact'),
    fit: has('rt-tbl-fit'),
    [border]: true,
    [talign]: true,
    [valign]: true,
  };
  for (const b of bar.querySelectorAll('[aria-pressed]')) b.setAttribute('aria-pressed', String(!!on[b.dataset.op]));
  bar.hidden = false;
  rtTblBarPlace();
}

function rtTblBarPlace() {
  if (!rtTblBar || rtTblBar.hidden || !rtTblBarTable) return;
  const t = rtTblBarTable.getBoundingClientRect();
  const b = rtTblBar.getBoundingClientRect();
  const rail = document.querySelector('#post-form > .rt-rail');
  const floor = Math.max(72, rail ? rail.getBoundingClientRect().bottom + 8 : 72);
  let top = t.top - b.height - 8;
  if (top < floor) top = Math.min(floor, t.bottom - b.height);
  const left = Math.max(8, Math.min(t.left, window.innerWidth - b.width - 8));
  rtTblBar.style.top = `${Math.round(top)}px`;
  rtTblBar.style.left = `${Math.round(left)}px`;
  rtTblBar.classList.toggle('is-offscreen', t.bottom < floor || t.top > window.innerHeight);
}

let rtTblBarRaf = 0;
document.addEventListener('selectionchange', () => {
  clearTimeout(rtTblBarRaf);
  rtTblBarRaf = setTimeout(rtTblBarSync, 30);
});
// Capture: the editor column scrolls on its own too (theme-sky.css).
window.addEventListener('scroll', () => rtTblBarPlace(), { passive: true, capture: true });
window.addEventListener('resize', () => rtTblBarPlace());

// The pop is fixed while the page underneath it scrolls, so it follows the same
// scroll and resize as the listbox menu - and lets go when its trigger leaves
// the screen rather than floating over unrelated content.
function repositionRtTable() {
  if (!rtTableTrigger) return;
  requestAnimationFrame(() => {
    if (!rtTableTrigger) return;
    const r = rtTableTrigger.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) {
      closeRtTable();
      return;
    }
    placeRtTable();
  });
}
window.addEventListener('scroll', repositionRtTable, true);
window.addEventListener('resize', repositionRtTable);

// ---- The image panel: sizing a picture that sits inside a paragraph -----------
// A click on an <img class="rt-inline-img"> raises a rim around it carrying three
// ways to change its width: the button in the middle of the picture (the article's
// full width, and back again), the handle on its right edge (dragged), and the
// exact steps underneath. All three write ONE class out of the .rt-img-* set in
// css/common.css - see the comment there for why it is a class and not a style
// attribute - so it makes no difference to the saved post which of the three the
// author used.
//
// Only a width is ever written. `height: auto` in that same stylesheet is what
// holds the ratio, so a picture taken to the full width of the article gets taller
// by exactly as much as its own proportions say and is never stretched.
//
// Parented to <body> and position:fixed for the reasons .rt-menu gives above, plus
// one of its own: syncEditorToBlock() stores editor.innerHTML, so chrome drawn
// INSIDE the contenteditable to decorate the picture would be saved into the post
// and then stripped by server/sanitize-html.js - a rim and a button that appear in
// the article and vanish on the reading page.
let rtImgPanelEl = null;
let rtImgTarget = null;
let rtImgDrag = null;

// The whole set, so "whatever size it was" is one loop rather than a regex over
// classList. 10 to 100 in steps of 5, matching css/common.css exactly.
const RT_IMG_ALL = Array.from({ length: 19 }, (_, i) => `rt-img-${10 + i * 5}`);
const RT_IMG_CLASS_RE = /^rt-img-(\d{2,3})$/;
// What the handle and the arrow keys move by, and the floor they stop at. Below
// 10% of an 832px measure a picture is 83px across, which is a thumbnail nobody
// meant to make.
const RT_IMG_STEP = 5;
const RT_IMG_MIN = 10;

function rtImgEditorOf(img) {
  return img && img.closest ? img.closest('.rt-editor') : null;
}

function rtImgCurrentPct(img) {
  if (!img) return null;
  for (const cls of img.classList) {
    const m = RT_IMG_CLASS_RE.exec(cls);
    if (m) return Number(m[1]);
  }
  return null;
}

// The block a picture's percentage is OF. width:N% on an <img> resolves against
// its containing block - the paragraph or list item it sits in, not the editor and
// not the page - so that is what a drag has to measure against, or the handle would
// run away from the pointer inside an indented paragraph or a list item.
// clientWidth less the padding: clientWidth already excludes the border and any
// scrollbar, and the padding is inside it but outside the content box the
// percentage resolves against. `left` is the content box's own left edge, which is
// where 0% is.
function rtImgHostBox(img) {
  const host = img.closest('p, li, td, th, blockquote, figcaption, div') || rtImgEditorOf(img);
  if (!host) return null;
  const cs = window.getComputedStyle(host);
  const padL = parseFloat(cs.paddingLeft || 0) || 0;
  const borderL = parseFloat(cs.borderLeftWidth || 0) || 0;
  return {
    width: host.clientWidth - padL - (parseFloat(cs.paddingRight || 0) || 0),
    left: host.getBoundingClientRect().left + borderL + padL,
  };
}

function rtImgSetPct(img, pct) {
  for (const cls of RT_IMG_ALL) img.classList.remove(cls);
  if (pct) img.classList.add(`rt-img-${pct}`);
  // classList.remove can leave class="" behind, which is still an attribute and
  // still something the sanitizer has to look at. It never does here - rt-inline-img
  // stays on - but everywhere else in this file an emptied class list loses the
  // attribute, and this is not the place to stop doing that.
  if (!img.className) img.removeAttribute('class');
  // The model is editor.innerHTML, so a class changed on the DOM is not saved until
  // this runs. Same pairing every toolbar command uses.
  const editor = rtImgEditorOf(img);
  if (editor) syncEditorToBlock(editor);
  syncRtImgPanel();
}

function syncRtImgPanel() {
  if (!rtImgTarget || !rtImgPanelEl) return;
  const pct = rtImgCurrentPct(rtImgTarget);
  const shown = pct === null ? '' : String(pct);
  for (const b of rtImgPanelEl.querySelectorAll('.rt-img-size')) {
    b.setAttribute('aria-pressed', String(b.dataset.w === shown));
  }
  // The middle button's label says what it WILL do, not what the picture is: at the
  // full width of the article the only move left is back to the picture's own size.
  const full = pct === 100;
  const zoom = rtImgPanelEl.querySelector('.rt-img-zoom');
  zoom.textContent = full ? 'Cỡ ban đầu' : 'Vừa chiều ngang';
  zoom.title = full
    ? 'Trả ảnh về cỡ ban đầu của nó'
    : 'Phóng to ảnh vừa chiều ngang bài viết, giữ nguyên tỉ lệ';
  zoom.setAttribute('aria-pressed', String(full));
  // A slider has to report a number, and no class at all is not one - so the
  // picture's own size is announced as a value text instead of as 0 or as 100.
  const handle = rtImgPanelEl.querySelector('.rt-img-handle');
  handle.setAttribute('aria-valuenow', String(pct === null ? 100 : pct));
  handle.setAttribute('aria-valuetext', pct === null ? 'Cỡ ban đầu của ảnh' : `${pct}% chiều ngang đoạn văn`);
  placeRtImgPanel();
}

function placeRtImgPanel() {
  const img = rtImgTarget;
  const panel = rtImgPanelEl;
  if (!img || !panel) return;
  const r = img.getBoundingClientRect();
  panel.style.left = `${Math.round(r.left)}px`;
  panel.style.top = `${Math.round(r.top)}px`;
  panel.style.width = `${Math.round(r.width)}px`;
  panel.style.height = `${Math.round(r.height)}px`;
  // The step row goes under the picture unless there is no room under it - and
  // "no room" has to count the dock, which is fixed to the bottom edge and is up
  // whenever the caret is in the paragraph this picture sits in, i.e. exactly now.
  const bar = panel.querySelector('.rt-img-bar');
  const GAP = 10;
  const EDGE = 8;
  const dock = document.getElementById('rt-dock');
  const dockH = dock && dock.classList.contains('is-open') ? dock.offsetHeight : 0;
  const barH = bar.offsetHeight;
  const tight = r.bottom + GAP + barH > window.innerHeight - EDGE - dockH;
  bar.classList.toggle('above', tight && r.top - GAP - barH > EDGE);
}

function openRtImgPanel(img) {
  rtImgTarget = img;
  const panel = rtImgPanel();
  // Un-hidden BEFORE the sync: placeRtImgPanel() measures the step row, and
  // offsetHeight on a display:none element is 0, which would put the row below the
  // picture on every picture near the bottom of the screen.
  panel.hidden = false;
  syncRtImgPanel();
}

function closeRtImgPanel() {
  rtImgDragEnd();
  rtImgTarget = null;
  if (rtImgPanelEl) rtImgPanelEl.hidden = true;
}

function rtImgPanel() {
  if (rtImgPanelEl) return rtImgPanelEl;
  const el = document.createElement('div');
  el.className = 'rt-img-panel';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Cỡ ảnh trong đoạn văn');
  el.hidden = true;
  // The middle button is built empty: syncRtImgPanel() writes its label, because
  // which way the toggle goes depends on the picture it just opened on.
  el.innerHTML = `
    <button type="button" class="rt-img-zoom" aria-pressed="false"></button>
    <div class="rt-img-handle" role="slider" tabindex="0" aria-label="Kéo để đổi cỡ ảnh"
      aria-valuemin="${RT_IMG_MIN}" aria-valuemax="100" aria-valuenow="100"></div>
    <div class="rt-img-bar" role="group" aria-label="Cỡ ảnh theo phần trăm chiều ngang">
      <button type="button" class="rt-img-size" data-w="">Tự động</button>
      <button type="button" class="rt-img-size" data-w="25">25%</button>
      <button type="button" class="rt-img-size" data-w="50">50%</button>
      <button type="button" class="rt-img-size" data-w="75">75%</button>
      <button type="button" class="rt-img-size" data-w="100">100%</button>
    </div>`;
  document.body.appendChild(el);

  el.addEventListener('click', (e) => {
    if (!rtImgTarget) return;
    const size = e.target.closest('.rt-img-size');
    if (size) {
      // data-w="" is "Tự động": no class at all, so the picture goes back to its own
      // size under the shared max-width / height:auto rules.
      rtImgSetPct(rtImgTarget, size.dataset.w ? Number(size.dataset.w) : null);
      return;
    }
    if (e.target.closest('.rt-img-zoom')) {
      rtImgSetPct(rtImgTarget, rtImgCurrentPct(rtImgTarget) === 100 ? null : 100);
    }
  });

  const handle = el.querySelector('.rt-img-handle');
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // mousedown is prevented across the whole panel (see the .rt-btn rule in
    // Wiring), so focus would never arrive on its own - and without it the arrow
    // keys below have nothing to fire on once the author lets go of the mouse.
    handle.focus();
    rtImgDragStart(e);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!rtImgDrag) return;
    e.preventDefault();
    rtImgDragMove(e);
  });
  handle.addEventListener('pointerup', rtImgDragEnd);
  handle.addEventListener('pointercancel', rtImgDragEnd);
  handle.addEventListener('keydown', (e) => {
    if (!rtImgTarget) return;
    const isArrow = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
    if (!isArrow && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const cur = rtImgCurrentPct(rtImgTarget);
    // No class is the picture's own size, which the arrows cannot step from - so
    // they start at the full width of the article and work in from there.
    const base = cur === null ? 100 : cur;
    const next = e.key === 'Home' ? RT_IMG_MIN
      : e.key === 'End' ? 100
        : base + (e.key === 'ArrowRight' ? RT_IMG_STEP : -RT_IMG_STEP);
    rtImgSetPct(rtImgTarget, Math.min(100, Math.max(RT_IMG_MIN, next)));
  });

  rtImgPanelEl = el;
  return el;
}

function rtImgDragStart(e) {
  if (!rtImgTarget) return;
  const box = rtImgHostBox(rtImgTarget);
  // No containing block to measure against (a detached picture, an engine that
  // refuses getComputedStyle mid-drag): better no resize than a resize against 0.
  if (!box || !box.width) return;
  rtImgDrag = box;
  rtImgPanelEl.classList.add('is-dragging');
  // Capture, because a drag leaves the 22px grip on the first pixel of movement and
  // without it every pointermove after that lands on whatever is under the cursor.
  if (e.target.setPointerCapture && e.pointerId !== undefined) {
    try {
      e.target.setPointerCapture(e.pointerId);
    } catch {
      // An engine that refuses capture still delivers pointermove while the button
      // is down over the handle, which is most of a drag. Not worth failing over.
    }
  }
  // The press is itself a move: a click on the grip with no drag should still take
  // the picture to the width the grip is at, not leave it where it was.
  rtImgDragMove(e);
}

function rtImgDragMove(e) {
  if (!rtImgDrag || !rtImgTarget) return;
  const pct = ((e.clientX - rtImgDrag.left) / rtImgDrag.width) * 100;
  const snapped = Math.min(100, Math.max(RT_IMG_MIN, Math.round(pct / RT_IMG_STEP) * RT_IMG_STEP));
  // Only write when the step actually changed. This fires on every pointermove, and
  // each write stores the whole paragraph's innerHTML back into the model.
  if (snapped !== rtImgCurrentPct(rtImgTarget)) rtImgSetPct(rtImgTarget, snapped);
}

function rtImgDragEnd() {
  if (!rtImgDrag) return;
  rtImgDrag = null;
  if (rtImgPanelEl) rtImgPanelEl.classList.remove('is-dragging');
}

// A click on a picture raises the panel; a click anywhere else lets it go. On the
// document because the panel lives in <body> while the pictures live in the blocks,
// and one listener has to see both - the same shape as the menu's.
//
// Every <img> inside an editor, not just .rt-inline-img. The upload path gives a
// picture that class, but rtAdoptStrayImages() deliberately leaves alone one whose
// src already survives the sanitizer - a picture copied out of another post on this
// site arrives that way - and it is no less a picture in a paragraph for having no
// class. .rt-image-preview cannot be caught here: it is the image BLOCK's own
// preview, rendered outside any .rt-editor, and is always the full width of the
// block with a caption field of its own to describe it.
document.addEventListener('click', (e) => {
  if (!e.target.closest) return;
  if (e.target.closest('.rt-img-panel')) return;
  const img = e.target.closest('.rt-editor img');
  if (img) {
    openRtImgPanel(img);
    return;
  }
  if (rtImgTarget) closeRtImgPanel();
});
// Escape from anywhere, for the reason the menu's own handler gives: a click
// elsewhere can move focus out without closing anything.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && rtImgTarget) closeRtImgPanel();
});
// The picture can be deleted or undone out from under the panel by a Backspace
// inside the paragraph, which re-renders nothing and so tells the panel nothing.
// Checked on input rather than only on scroll, so the rim does not sit there over
// the text that replaced it until the author happens to scroll.
document.addEventListener('input', () => {
  if (rtImgTarget && !document.contains(rtImgTarget)) closeRtImgPanel();
});

// Fixed while the page scrolls under it, so re-placed on every scroll - and let go
// of once the picture has left the screen rather than left floating over unrelated
// content. Capture phase because the scroll may come from a nested container and
// scroll does not bubble; rAF-throttled so a fast scroll costs one placement per
// frame. Both for the reasons repositionRtMenu() gives.
let rtImgPlacePending = false;
function repositionRtImgPanel() {
  if (!rtImgTarget || rtImgPlacePending) return;
  rtImgPlacePending = true;
  requestAnimationFrame(() => {
    rtImgPlacePending = false;
    if (!rtImgTarget) return;
    if (!document.contains(rtImgTarget)) {
      closeRtImgPanel();
      return;
    }
    const r = rtImgTarget.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) {
      closeRtImgPanel();
      return;
    }
    placeRtImgPanel();
  });
}
window.addEventListener('scroll', repositionRtImgPanel, true);
window.addEventListener('resize', repositionRtImgPanel);
// Backstop for a drag that ends somewhere the handle never hears about - capture
// lost because the panel was re-rendered mid-drag, or an engine that declines the
// capture in the first place. Without it rtImgDrag would stay set and the next
// pointermove over where the grip used to be would resize a picture nobody is
// holding. rtImgDragEnd() returns early when there is no drag, so the handle's own
// pointerup and this one are free to both fire.
window.addEventListener('pointerup', rtImgDragEnd);

// ---- Wiring -----------------------------------------------------------------
// The post page scopes the engine's behavioural handlers to the block list; a
// page that loads the engine without a post form (/terms.html, for its clause
// editor) has no such container, so the same handlers scope to the document.
// Every one of them guards on .rt-editor or a block class before acting, so
// widening the scope changes nothing on the write page and is what makes the
// engine reach editors that live elsewhere.
const blocksContainer = document.getElementById('blocks-container') || document.body;

// The caret moved: re-read the toolbar's state from wherever it landed.
['mouseup', 'keyup', 'focusin'].forEach((evt) => {
  blocksContainer.addEventListener(evt, (e) => {
    const editor = e.target.closest('.rt-editor');
    if (editor) saveRtSelection(editor);
    syncRtToolbars();
  });
});
// Focus LEAVING is what lowers the bar, and it must be watched on the document:
// focus can move from an editor into the dock (which lives in <body>) or out to
// the title field, and neither passes through #blocks-container. Read on the NEXT
// frame, not from relatedTarget: between blurring an editor and focusing a dock
// button there is a moment where focus is on <body>, and acting on it then would
// drop the bar and raise it again on every single button press.
document.addEventListener('focusout', () => requestAnimationFrame(syncRtDock));
document.addEventListener('focusin', syncRtDock);
// A drag-select that ends outside the editor, or a caret moved by the browser's
// own undo, never fires the events above.
document.addEventListener('selectionchange', () => {
  const editor = activeRtEditor();
  if (editor) saveRtSelection(editor);
  syncRtToolbars();
});

// Toolbar buttons must not steal focus: taking it would collapse the selection
// before the click handler runs execCommand. The triggers are excluded - they
// deliberately DO take focus, and restore the selection themselves.
// On the document, not on #blocks-container: the dock lives in <body>.
document.addEventListener('mousedown', (e) => {
  // The image panel too: it floats over a picture inside the paragraph, and a
  // mousedown that moved focus into it would take the caret out of that paragraph -
  // which is the editor the picture's own size change has to be written back into.
  if (e.target.closest('.rt-btn') || e.target.closest('.rt-img-panel')) e.preventDefault();
});

// One click handler for the page. On the document rather than on
// #blocks-container because the toolbar and its menus are parented to <body>:
// the block controls, the docked buttons and the heading trigger inside a block
// all arrive here.
document.addEventListener('click', async (e) => {
  const upBtn = e.target.closest('.block-move-up');
  const downBtn = e.target.closest('.block-move-down');
  const removeBtn = e.target.closest('.block-remove');
  const trigger = e.target.closest('.rt-menu-trigger');
  const tableTrigger = e.target.closest('.rt-table-trigger');
  const rtBtn = e.target.closest('.rt-btn');

  if (upBtn) {
    const idx = blocks.findIndex((b) => b.key === Number(upBtn.dataset.key));
    if (idx > 0) [blocks[idx - 1], blocks[idx]] = [blocks[idx], blocks[idx - 1]];
    renderBlocks();
  } else if (downBtn) {
    const idx = blocks.findIndex((b) => b.key === Number(downBtn.dataset.key));
    if (idx < blocks.length - 1) [blocks[idx + 1], blocks[idx]] = [blocks[idx], blocks[idx + 1]];
    renderBlocks();
  } else if (removeBtn) {
    blocks = blocks.filter((b) => b.key !== Number(removeBtn.dataset.key));
    renderBlocks();
  } else if (trigger) {
    // Toggling, so a second click on the same pill closes it. The selection is
    // saved first: opening the menu moves focus into it and collapses the range
    // every command below needs.
    const wasOpen = rtMenuTrigger === trigger;
    const editor = activeRtEditor();
    if (editor) saveRtSelection(editor);
    closeRtMenu();
    if (!wasOpen) openRtMenu(trigger);
  } else if (tableTrigger) {
    // Toggling, like the listbox pills: a second click on "Bảng" closes the
    // picker. The selection is saved first for the same reason as above - the
    // caret the table has to land on stays in the paragraph while focus moves
    // to the pill and then into the grid.
    const wasOpen = rtTableTrigger === tableTrigger;
    const editor = activeRtEditor();
    if (editor) saveRtSelection(editor);
    closeRtTable();
    if (!wasOpen) openRtTable(tableTrigger);
  } else if (rtBtn) {
    // The link button opens a dialog asking for the address first - a link needs
    // a URL from the author, which no execCommand can supply on its own.
    if (rtBtn.dataset.link) {
      openRtLink();
      return;
    }
    // The docked buttons carry no block key - they act on whichever editor holds
    // the caret. mousedown was prevented, so focus has not moved and the saved
    // range is still the one the author made.
    const editor = restoreRtSelection() || activeRtEditor();
    if (!editor) return;
    if (document.activeElement !== editor) editor.focus();

    if (rtBtn.classList.contains('rt-clear-btn')) {
      rtClearFormatting(editor);
    } else if (rtBtn.dataset.quoteBlock) {
      rtToggleQuote(editor);
    } else if (rtBtn.dataset.quoteInline) {
      rtToggleInlineQuote(editor);
    } else if (rtBtn.dataset.codeBlock) {
      rtInsertCodeBlock(editor);
    } else if (rtBtn.dataset.class) {
      rtApplyBlockClass(editor, rtBtn.dataset.class, (rtBtn.dataset.group || '').split(' ').filter(Boolean));
    } else {
      document.execCommand(rtBtn.dataset.cmd, false, rtBtn.dataset.value || undefined);
      // execCommand('hiliteColor') writes the literal colour it is handed into a
      // style attribute. Converting it to .rt-mark HERE, not only on save, is what
      // makes a highlight readable in the editor on the dark theme: the raw yellow
      // puts a pale background behind near-white ink, and the class carries the
      // themed pair (see markInlineHighlights() in js/api.js and --c-rt-mark).
      if (rtBtn.dataset.cmd === 'hiliteColor') markInlineHighlights(editor);
    }
    syncEditorToBlock(editor);
    saveRtSelection(editor);
    syncRtToolbars();
  }
});


// The other half of role="toolbar": the arrow keys move between its controls and
// Home/End jump to the ends, with the tabindex following focus so tabbing back in
// returns to where the author left off. Left/Right AND Up/Down, because the
// toolbar wraps onto several rows at narrow widths - which row a button is on is
// a layout accident, so binding only one axis would strand half of them.
// A menu trigger keeps Down for opening its menu, the one thing a listbox
// trigger is expected to do.
document.addEventListener('keydown', (e) => {
  const btn = e.target.closest('.rt-toolbar > button');
  if (!btn) return;
  const isTrigger = btn.classList.contains('rt-menu-trigger');
  const isTableTrigger = btn.classList.contains('rt-table-trigger');
  if ((isTrigger || isTableTrigger) && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    if (isTableTrigger) openRtTable(btn);
    else openRtMenu(btn);
    return;
  }
  const KEYS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  const step = KEYS[e.key];
  if (step === undefined && e.key !== 'Home' && e.key !== 'End') return;
  e.preventDefault();
  const items = [...btn.closest('.rt-toolbar').querySelectorAll('button')];
  const i = items.indexOf(btn);
  const next =
    e.key === 'Home' ? items[0]
    : e.key === 'End' ? items[items.length - 1]
    : items[(i + step + items.length) % items.length];
  // The tab stop moves with focus, so Tab out and back returns here rather than
  // to the first button.
  for (const item of items) item.tabIndex = item === next ? 0 : -1;
  next.focus();
});

// Paste into a paragraph. Delegated on the container rather than bound to each
// editor: renderBlocks() rebuilds every editor whenever a block is added, moved or
// deleted, and a listener attached to one of them is rebuilt with it. The
// container outlives all of them.
// ---- Markdown in the editor ----
// Two ways in, both producing the editor's OWN markup (h2/h3, lists, the
// .rt-quote blockquote, the .rt-code terminal block, tables with a header row),
// so a Markdown-made paragraph is indistinguishable from a toolbar-made one:
//
//   1. Typing shortcuts at the start of an empty-ish line, on Space:
//        #  ## -> Tiêu đề 2     ### -> Tiêu đề 3     - * + -> bullet list
//        1. -> numbered list    > -> quotation
//      on Enter:  ```lang -> terminal block    --- -> divider line
//      and inline as the closing mark is typed:
//        **đậm**  *nghiêng* / _nghiêng_  ~~gạch~~  `code`
//   2. Pasting Markdown text (from ChatGPT, GitHub, Obsidian, a .md file...):
//      converted instead of landing as raw "## " and "**".
//
// Text is always set through textContent / escaped before any markup is built,
// and links keep only http(s)/mailto - the server sanitizer re-checks it all.

function rtMdEscape(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Inline Markdown -> HTML string, escape-first.
function rtMdInline(text) {
  const keep = [];
  const hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
  let s = rtMdEscape(text);
  s = s.replace(/`([^`\n]+)`/g, (m, code) => hold(`<code>${code}</code>`));
  s = s.replace(/!\[([^\]\n]*)\]\(((?:https?:\/\/)[^\s)]+)\)/g, (m, alt, src) =>
    hold(rtImgSrcSurvives(src) ? `<img src="${src}" alt="${alt}">` : `<a href="${src}">${alt || src}</a>`)
  );
  s = s.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (m, label, href) => hold(`<a href="${href}">${label}</a>`));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (m, pre, url) => pre + hold(`<a href="${url}">${url}</a>`));
  s = s
    .replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+?)__/g, '<b>$1</b>')
    .replace(/~~([^~\n]+?)~~/g, '<s>$1</s>')
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?!\w)/g, '$1<i>$2</i>');
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => keep[Number(i)]);
}

function rtMdCodeBlock(lang, body) {
  const wrap = document.createElement('div');
  wrap.className = 'rt-code';
  const label = document.createElement('div');
  label.className = 'rt-code-lang';
  label.textContent = lang || 'bash';
  const pre = document.createElement('pre');
  pre.className = 'rt-code-body';
  const code = document.createElement('code');
  code.textContent = body;
  pre.appendChild(code);
  wrap.append(label, pre);
  return wrap;
}

function rtMdHtmlNode(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content;
}

// A run of list lines -> nested <ul>/<ol> by indentation.
function rtMdList(lines) {
  const root = document.createDocumentFragment();
  const stack = []; // { indent, list }
  for (const line of lines) {
    const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!m) {
      // A continuation line: append to the last item.
      const last = stack.length && stack[stack.length - 1].list.lastElementChild;
      if (last) last.append(document.createElement('br'), rtMdHtmlNode(rtMdInline(line.trim())));
      continue;
    }
    const indent = m[1].replace(/\t/g, '    ').length;
    const tag = /\d/.test(m[2]) ? 'OL' : 'UL';
    while (stack.length && indent < stack[stack.length - 1].indent) stack.pop();
    let top = stack[stack.length - 1];
    if (!top || indent > top.indent || top.list.tagName !== tag) {
      const list = document.createElement(tag.toLowerCase());
      if (top && indent > top.indent && top.list.lastElementChild) top.list.lastElementChild.appendChild(list);
      else root.appendChild(list);
      if (top && indent === top.indent) stack.pop();
      stack.push({ indent, list });
      top = stack[stack.length - 1];
    }
    const li = document.createElement('li');
    let body = m[3];
    const task = /^\[([ xX])\]\s+(.*)$/.exec(body);
    if (task) body = `${task[1] === ' ' ? '☐' : '☑'} ${task[2]}`;
    li.appendChild(rtMdHtmlNode(rtMdInline(body)));
    top.list.appendChild(li);
  }
  return root;
}

function rtMdTable(lines) {
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const table = document.createElement('table');
  const thead = table.createTHead();
  const hr = thead.insertRow();
  for (const c of cells(lines[0])) {
    const th = document.createElement('th');
    th.setAttribute('scope', 'col');
    th.appendChild(rtMdHtmlNode(rtMdInline(c)));
    hr.appendChild(th);
  }
  const tbody = table.createTBody();
  for (const l of lines.slice(2)) {
    const tr = tbody.insertRow();
    for (const c of cells(l)) tr.insertCell().appendChild(rtMdHtmlNode(rtMdInline(c)));
  }
  return table;
}

// Markdown text -> DocumentFragment of editor blocks.
function rtMarkdownToFragment(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const frag = document.createDocumentFragment();
  let i = 0;
  const isBlank = (l) => !l || !l.trim();
  const isList = (l) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
  const isTableSep = (l) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l || '');
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i += 1; continue; }
    const fence = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i += 1;
      frag.appendChild(rtMdCodeBlock(fence[2], body.join('\n')));
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const el = document.createElement(h[1].length <= 2 ? 'h2' : 'h3');
      el.appendChild(rtMdHtmlNode(rtMdInline(h[2])));
      frag.appendChild(el);
      i += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { frag.appendChild(document.createElement('hr')); i += 1; continue; }
    if (line.includes('|') && isTableSep(lines[i + 1])) {
      const rows = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) rows.push(lines[i++]);
      frag.appendChild(rtMdTable(rows));
      continue;
    }
    if (/^\s*>/.test(line)) {
      const inner = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) inner.push(lines[i++].replace(/^\s*>\s?/, ''));
      const bq = document.createElement('blockquote');
      bq.className = RT_QUOTE_CLASS;
      bq.appendChild(rtMarkdownToFragment(inner.join('\n')));
      frag.appendChild(bq);
      continue;
    }
    if (isList(line)) {
      const run = [];
      while (i < lines.length && (isList(lines[i]) || (!isBlank(lines[i]) && /^\s{2,}\S/.test(lines[i])))) run.push(lines[i++]);
      frag.appendChild(rtMdList(run));
      continue;
    }
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && !/^\s*(#{1,6}\s|```|~~~|>)/.test(lines[i]) && !isList(lines[i])) para.push(lines[i++]);
    const p = document.createElement('p');
    p.appendChild(rtMdHtmlNode(para.map(rtMdInline).join('<br>')));
    frag.appendChild(p);
  }
  return frag;
}

// Is this plain text Markdown, rather than ordinary prose? Strong signals
// (a heading, a fence, a table) count on their own; weaker ones need company.
function rtLooksLikeMarkdown(text) {
  const t = String(text || '');
  if (t.length < 3) return false;
  if (/^#{1,6}\s+\S/m.test(t) || /^\s*(```|~~~)/m.test(t) || /^\s*\|.+\|\s*\n\s*\|?\s*:?-{3,}/m.test(t)) return true;
  let score = 0;
  if (/\*\*[^*\n]+\*\*/.test(t)) score += 1;
  if (/\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/.test(t)) score += 1;
  if (/^\s*[-*+]\s+\S/m.test(t)) score += 1;
  if (/^\s*\d+\.\s+\S/m.test(t)) score += 1;
  if (/^>\s?\S/m.test(t)) score += 1;
  if (/`[^`\n]+`/.test(t)) score += 1;
  return score >= 2;
}

// Puts blocks at the caret: the paragraph the caret is in is split there (the
// same shape rtInsertCodeBlock() leaves), the blocks go between the halves,
// and empty halves go away. A DOM write, like the code block, because
// insertHTML lets the engine "simplify" nested block markup.
function rtInsertFragmentAtCaret(editor, frag) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) range.deleteContents();
  const nodes = [...frag.childNodes];
  if (!nodes.length) return;
  let container = rtCurrentBlock(editor, { create: true });
  if (container && container !== editor && container.parentElement === editor) {
    const tailRange = document.createRange();
    tailRange.selectNodeContents(container);
    tailRange.setStart(range.endContainer, range.endOffset);
    const tail = container.cloneNode(false);
    tail.appendChild(tailRange.extractContents());
    container.after(...nodes);
    if (rtBlockHasContent(tail)) nodes[nodes.length - 1].after(tail);
    if (!rtBlockHasContent(container)) container.remove();
  } else {
    // Inside a list item, a quotation, a table...: after the top-level block.
    let top = container && container !== editor ? container : null;
    while (top && top.parentElement !== editor) top = top.parentElement;
    if (top) top.after(...nodes);
    else editor.append(...nodes);
  }
  const last = nodes[nodes.length - 1];
  const caret = document.createRange();
  caret.selectNodeContents(last.matches?.('.rt-code') ? last.querySelector('code') : last);
  caret.collapse(false);
  sel.removeAllRanges();
  sel.addRange(caret);
  editor.classList.remove('is-empty');
  syncEditorToBlock(editor);
  saveRtSelection(editor);
  syncRtToolbars();
}

// Paste: Markdown text becomes formatted blocks. Skipped when the clipboard
// already carries real rich markup (a web page, Word, Google Docs - the normal
// rich paste is better), inside a terminal block (code stays verbatim), and
// inside a table cell.
function rtMarkdownPaste(editor, e) {
  const dt = e.clipboardData;
  if (!dt) return false;
  const text = dt.getData('text/plain');
  if (!rtLooksLikeMarkdown(text)) return false;
  const html = dt.getData('text/html');
  if (html && /<(h[1-6]|ul|ol|li|strong|b|em|i|table|pre|blockquote)\b/i.test(html)) return false;
  const sel = window.getSelection();
  let node = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
  if (node && node.nodeType !== 1) node = node.parentElement;
  if (node && node.closest && node.closest('.rt-code, pre, td, th')) return false;
  e.preventDefault();
  rtInsertFragmentAtCaret(editor, rtMarkdownToFragment(text));
  return true;
}

// Text from the start of the caret's block up to the caret.
function rtTextBeforeCaret(block) {
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return null;
  const r = document.createRange();
  r.selectNodeContents(block);
  r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  return r.toString();
}

function rtDeleteBeforeCaret(block) {
  const sel = window.getSelection();
  const r = document.createRange();
  r.selectNodeContents(block);
  r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  sel.removeAllRanges();
  sel.addRange(r);
  document.execCommand('delete');
}

// Space / Enter shortcuts at the start of a plain paragraph.
blocksContainer.addEventListener('keydown', (e) => {
  if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key !== ' ' && e.key !== 'Enter') return;
  const editor = e.target.closest && e.target.closest('.rt-editor');
  if (!editor) return;
  // A fresh block holds bare text with no <p> around it; Enter shortcuts need a
  // block to replace, so make one (formatBlock, like the toolbar does).
  const block = rtCurrentBlock(editor, { create: e.key === 'Enter' });
  const plain = block && (block.tagName === 'P' || block.tagName === 'DIV') && !block.closest('.rt-code, td, th, li');
  if (!plain && block) return;
  const target = block || editor;
  const before = rtTextBeforeCaret(target);
  if (before == null) return;
  const mark = before.replace(/ /g, ' ');
  let done = false;
  if (e.key === ' ') {
    if (/^#{1,6}$/.test(mark)) {
      e.preventDefault();
      rtDeleteBeforeCaret(target);
      document.execCommand('formatBlock', false, mark.length <= 2 ? 'h2' : 'h3');
      done = true;
    } else if (/^[-*+]$/.test(mark)) {
      e.preventDefault();
      rtDeleteBeforeCaret(target);
      document.execCommand('insertUnorderedList');
      done = true;
    } else if (/^\d+[.)]$/.test(mark)) {
      e.preventDefault();
      rtDeleteBeforeCaret(target);
      document.execCommand('insertOrderedList');
      done = true;
    } else if (mark === '>' && !target.closest('blockquote')) {
      e.preventDefault();
      rtDeleteBeforeCaret(target);
      rtToggleQuote(editor);
      done = true;
    }
  } else if (e.key === 'Enter' && !e.shiftKey && block) {
    const whole = block.textContent.replace(/ /g, ' ').trim();
    const fence = /^(```|~~~)\s*([\w+#.-]*)$/.exec(whole);
    if (fence && mark.trim() === whole) {
      e.preventDefault();
      rtDeleteBeforeCaret(block);
      rtInsertCodeBlock(editor);
      const label = window.getSelection().anchorNode?.parentElement?.closest('.rt-code')?.querySelector('.rt-code-lang');
      if (label && fence[2]) label.textContent = fence[2];
      done = true;
    } else if (/^([-*_])(\s*\1){2,}$/.test(whole) && mark.trim() === whole) {
      e.preventDefault();
      const hr = document.createElement('hr');
      const next = document.createElement('p');
      next.appendChild(document.createElement('br'));
      block.replaceWith(hr, next);
      const r = document.createRange();
      r.setStart(next, 0);
      r.collapse(true);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(r);
      done = true;
    }
  }
  if (done) {
    syncEditorToBlock(editor);
    saveRtSelection(editor);
    syncRtToolbars();
  }
});

// Inline marks, applied the moment the closing character is typed.
const RT_MD_INLINE = [
  { re: /\*\*([^*\n]+)\*\*$/, cmd: 'bold' },
  { re: /__([^_\n]+)__$/, cmd: 'bold' },
  { re: /~~([^~\n]+)~~$/, cmd: 'strikeThrough' },
  { re: /`([^`\n]+)`$/, cmd: 'code' },
  { re: /(?:^|[^*\w])\*([^*\s][^*\n]*)\*$/, cmd: 'italic' },
  { re: /(?:^|[^_\w])_([^_\s][^_\n]*)_$/, cmd: 'italic' },
];
// A range from character `a` to character `b` of root's text (the same count
// Range.toString() gives), across however many text nodes the engine has
// split it into.
function rtCharRange(root, a, b) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const r = document.createRange();
  let pos = 0;
  let startSet = false;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const len = t.data.length;
    if (!startSet && a <= pos + len) {
      r.setStart(t, a - pos);
      startSet = true;
    }
    if (startSet && b <= pos + len) {
      r.setEnd(t, b - pos);
      return r;
    }
    pos += len;
  }
  return null;
}

blocksContainer.addEventListener('input', (e) => {
  if (e.inputType !== 'insertText' || !['*', '_', '~', '`'].includes(e.data)) return;
  const editor = e.target.closest && e.target.closest('.rt-editor');
  if (!editor) return;
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  let at = sel.anchorNode;
  if (at && at.nodeType !== 1) at = at.parentElement;
  if (!at || at.closest('code, pre, .rt-code')) return;
  const block = rtCurrentBlock(editor) || editor;
  const text = rtTextBeforeCaret(block);
  if (!text) return;
  for (const rule of RT_MD_INLINE) {
    const m = rule.re.exec(text);
    if (!m) continue;
    const inner = m[1];
    // The marked run, markers included, ends at the caret. The italic patterns
    // also match the character before the opening mark, so count from inner.
    const runLen = rule.cmd === 'italic' ? inner.length + 2 : m[0].length;
    const runStart = text.length - runLen;
    const r = rtCharRange(block, runStart, text.length);
    if (!r) return;
    sel.removeAllRanges();
    sel.addRange(r);
    // One insertHTML (so Ctrl+Z undoes it in one step), with a zero-width
    // space after the mark: the caret lands in that text node, OUTSIDE the
    // mark, so what is typed next is plain. syncEditorToBlock() strips it from
    // the saved html.
    const tag = { bold: 'b', italic: 'i', strikeThrough: 's', code: 'code' }[rule.cmd];
    document.execCommand('insertHTML', false, `<${tag}>${rtMdEscape(inner)}</${tag}>\u200B`);
    syncEditorToBlock(editor);
    saveRtSelection(editor);
    syncRtToolbars();
    break;
  }
});

blocksContainer.addEventListener('paste', (e) => {
  const editor = e.target.closest('.rt-editor');
  if (!editor) return;
  const key = editor.dataset.key;

  // Markdown text (no picture, no rich markup) is converted - see "Markdown in
  // the editor" above. Anything else goes the usual way.
  try {
    if (!rtClipboardImages(e.clipboardData).length && rtMarkdownPaste(editor, e)) return;
  } catch (err) {
    // fall through to the normal paste
  }

  // Wrapped, and the fallback matters more than the wrap. A throw anywhere in the
  // takeover leaves the browser to paste its own data: image, which the sanitizer
  // blanks on save - a picture that was on the screen and is not in the article,
  // with nothing anywhere to say what happened. Letting the default run and then
  // adopting what it produced degrades to the same visible outcome as the good
  // path, one progress chip later.
  let tookOver = false;
  try {
    // Synchronous where it has to be - the preventDefault() and the read of
    // clipboardData both happen before this returns, which is the only part the
    // browser allows to be late about - and the uploads run after it.
    tookOver = rtHandleEditorPaste(editor, e);
  } catch (err) {
    tookOver = false;
  }
  if (tookOver) return;

  // Marks every heading already in the editor BEFORE the browser's default
  // paste runs, so the pass below can tell "the author's own Tiêu đề 2/3"
  // from "a heading the pasted markup brought with it" - only the second kind
  // gets flattened. Read back and cleared once the paste has landed; nothing
  // permanent, and nothing the sanitizer/save path ever sees.
  const preexisting = new Set(editor.querySelectorAll('h1, h2, h3, h4, h5, h6'));
  const preexistingTables = new Set(editor.querySelectorAll('table'));

  // Next tick, not now: the default paste has not been applied yet while this
  // handler is running, so there is nothing to adopt until it has landed.
  // Re-resolved by key rather than holding the element, because the paste can be
  // the thing that triggers a re-render in an engine that fires input first.
  setTimeout(() => {
    const editor = rtLiveEditor(key);
    // What the browser inserted is the source document's own markup, font,
    // colours and all, and this is the path that never went through
    // rtCleanPastedFragment() - a plain paste with no picture in it. Same
    // passes, same order, same reason: see the comments there. Headings are
    // scoped to the ones NOT in `preexisting` - see the comment above.
    if (editor) {
      rtFlattenHeadings(editor, preexisting);
      for (const t of editor.querySelectorAll('table')) if (!preexistingTables.has(t)) rtTblClean(t);
      normalizeInheritedTypography(editor);
      markInlineHighlights(editor);
      stripLiteralColours(editor);
    }
    rtAdoptStrayImages(editor);
  }, 0);
});

// A picture dragged off the desktop and dropped onto a paragraph. The
// window-level handler at the bottom of this file cancels every drop outside the
// cover dropzone, so without this dragging a file onto the article did nothing at
// all - which reads as the editor refusing rather than as a feature nobody wrote.
blocksContainer.addEventListener('drop', (e) => {
  const editor = e.target.closest('.rt-editor');
  if (!editor) return;
  const files = [...(e.dataTransfer?.files || [])].filter((f) => /^image\//.test(f.type || ''));
  if (!files.length) return;
  e.preventDefault();
  // The point it was dropped on IS the position being asked for. The caret's own
  // place is the fallback, and only because an engine with neither
  // caretRangeFromPoint nor caretPositionFromPoint has nothing better to offer.
  const range = rtRangeFromPoint(editor, e.clientX, e.clientY) || rtCaptureRange(editor);
  rtPlaceFiles({ key: editor.dataset.key, range }, files);
});

blocksContainer.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.classList.contains('block-layout-kind')) {
    const block = findBlock(t.dataset.key);
    if (block) block.layout = t.value;
    renderBlocks();
    return;
  }
  if (t.classList.contains('block-layout-file')) {
    const file = t.files[0];
    if (file) uploadLayoutImage(Number(t.dataset.key), Number(t.dataset.idx), file);
    return;
  }
  if (t.classList.contains('block-layout-url')) {
    // Re-render on commit (not on every keystroke) so the thumbnail and the
    // preview catch up with a pasted URL without stealing the caret mid-word.
    renderBlocks();
    return;
  }
  if (t.classList.contains('block-image-file')) {
    const file = t.files[0];
    if (!file) return;
    const key = Number(t.dataset.key);
    const status = document.querySelector(`.block-image-status[data-key="${key}"]`);
    status.textContent = 'Đang tải ảnh lên...';
    status.classList.remove('hidden');
    try {
      // The library endpoint, not the avatar one: an author writing a post is an
      // editor or an admin, and an admin has no per-file size limit there. The
      // upload is also recorded in the library, so the same image can be reused in
      // another post without being sent again.
      const { url } = await API.uploadImage(file, {
        endpoint: '/media',
        onProgress: (ratio, loaded, total) => {
          status.textContent = `Đang tải lên ${Math.round(ratio * 100)}% (${formatUploadBytes(loaded)} / ${formatUploadBytes(total)})`;
        },
      });
      findBlock(key).url = url;
      renderBlocks();
    } catch (err) {
      status.textContent = err.message;
    }
  }
});

// Short local formatter: media.js has its own, but write.js must not depend on that
// file being present - the picker degrades to upload-only if it is missing.
function formatUploadBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// "Thư viện" on an image block, and the same button under the cover-image field.
// openMediaPicker() comes from js/media.js and resolves with the chosen image, or
// null when the modal is dismissed - so this reads as a prompt.
blocksContainer.addEventListener('click', async (e) => {
  const layLib = e.target.closest('.block-layout-library');
  if (layLib) {
    if (typeof openMediaPicker !== 'function') return;
    const key = Number(layLib.dataset.key);
    const chosen = await openMediaPicker();
    if (!chosen) return;
    const block = findBlock(key);
    if (!block) return;
    const im = layoutImageAt(block, Number(layLib.dataset.idx));
    im.url = chosen.url;
    renderBlocks();
    return;
  }
  const layRemove = e.target.closest('.block-layout-remove');
  if (layRemove) {
    const block = findBlock(layRemove.dataset.key);
    if (block && Array.isArray(block.images)) {
      block.images.splice(Number(layRemove.dataset.idx), 1);
      layoutCompact(block);
    }
    renderBlocks();
    return;
  }
  const layAdd = e.target.closest('.block-layout-add');
  if (layAdd) {
    const key = Number(layAdd.dataset.key);
    const block = findBlock(key);
    if (!block) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    input.multiple = true;
    input.addEventListener('change', async () => {
      layoutCompact(block);
      const def = imageLayoutDef(block.layout);
      const room = (def.max || def.count) - block.images.filter((im) => im.url).length;
      const files = [...input.files].slice(0, Math.max(0, room));
      // One after the other: each upload re-renders the block, and a parallel
      // batch would race over which slot index is still free.
      for (const file of files) {
        const idx = block.images.filter((im) => im.url).length;
        await uploadLayoutImage(key, idx, file);
      }
      if (input.files.length > files.length) layoutStatus(key, `Kiểu này tối đa ${def.max || def.count} ảnh — đã bỏ qua ${input.files.length - files.length} ảnh.`, true);
    });
    input.click();
    return;
  }

  const libraryBtn = e.target.closest('.block-image-library');
  if (libraryBtn) {
    if (typeof openMediaPicker !== 'function') return;
    const key = Number(libraryBtn.dataset.key);
    const chosen = await openMediaPicker();
    if (!chosen) return;
    findBlock(key).url = chosen.url;
    renderBlocks();
    return;
  }

  const embedBtn = e.target.closest('.block-embed-load');
  if (embedBtn) {
    const key = Number(embedBtn.dataset.key);
    await resolveEmbedBlock(key);
  }
});

// Asks the server to turn the pasted URL into an embeddable frame.
//
// The resolve happens server-side deliberately: server/embeds.js is the same code
// that re-checks the stored src on save, so the editor cannot accept something the
// sanitiser would later strip - which would look like the embed silently vanishing
// after publishing.
async function resolveEmbedBlock(key) {
  const block = findBlock(key);
  if (!block) return;
  const input = document.querySelector(`.block-embed-url[data-key="${key}"]`);
  const status = document.querySelector(`.block-embed-status[data-key="${key}"]`);
  const url = (input ? input.value : block.url || '').trim();

  const show = (message, isError) => {
    if (!status) return;
    status.textContent = message;
    status.classList.remove('hidden');
    status.classList.toggle('text-error', Boolean(isError));
  };

  if (!url) return show('Hãy dán một đường dẫn trước.', true);
  block.url = url;
  show('Đang kiểm tra đường dẫn...', false);

  try {
    const { embed } = await API.resolveEmbed(url);
    Object.assign(block, {
      src: embed.src,
      provider: embed.provider || '',
      title: embed.title || '',
      ratio: embed.ratio || '',
      height: embed.height || null,
    });
    renderBlocks();
  } catch (err) {
    // The block keeps its url so the author can fix a typo rather than retype it,
    // and src is cleared so a previously-working embed is not left showing while the
    // field says something else.
    block.src = '';
    block.provider = '';
    renderBlocks();
    const after = document.querySelector(`.block-embed-status[data-key="${key}"]`);
    if (after) {
      after.textContent = err.message;
      after.classList.remove('hidden');
      after.classList.add('text-error');
    }
  }
}

blocksContainer.addEventListener('input', (e) => {
  const t = e.target;
  if (t.classList.contains('block-paragraph-editor')) {
    // syncEditorToBlock rather than a bare assignment: it also toggles .is-empty
    // (the placeholder survives the stray <br> a browser leaves behind in an
    // emptied contenteditable) and updates the word count.
    syncEditorToBlock(t);
  } else if (t.classList.contains('block-heading-text')) {
    findBlock(t.dataset.key).text = t.value;
  } else if (t.classList.contains('block-image-url')) {
    findBlock(t.dataset.key).url = t.value;
  } else if (t.classList.contains('block-image-caption')) {
    findBlock(t.dataset.key).caption = t.value;
  } else if (t.classList.contains('block-layout-url')) {
    const im = layoutImageAt(findBlock(t.dataset.key), Number(t.dataset.idx));
    im.url = t.value.trim();
    delete im.width; // the server looks the size up again on save
    delete im.height;
  } else if (t.classList.contains('block-layout-alt')) {
    layoutImageAt(findBlock(t.dataset.key), Number(t.dataset.idx)).alt = t.value;
  } else if (t.classList.contains('block-layout-caption')) {
    findBlock(t.dataset.key).caption = t.value;
  } else if (t.classList.contains('block-embed-url')) {
    // Typed but not yet resolved: the url is kept so a re-render does not lose it,
    // and src is cleared because it no longer matches what the field says.
    const block = findBlock(t.dataset.key);
    block.url = t.value;
    block.src = '';
  } else if (t.classList.contains('block-embed-caption')) {
    findBlock(t.dataset.key).caption = t.value;
  }
});

// Enter in the embed URL field resolves it, rather than submitting the whole post -
// which is what a bare Enter in a form field would otherwise do.
blocksContainer.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.classList.contains('block-embed-url')) return;
  e.preventDefault();
  resolveEmbedBlock(Number(e.target.dataset.key));
});

// Ctrl+B / I / U are handled by the browser inside a contenteditable, so the
// toolbar has to be re-read after one - and the browser's own undo can put back a
// mark this code never applied.
blocksContainer.addEventListener('keydown', (e) => {
  if (!e.target.closest('.rt-editor')) return;
  if (!e.ctrlKey && !e.metaKey) return;
  requestAnimationFrame(syncRtToolbars);
});

// Tab inside a table walks the caret from cell to cell - Word's habit, and the
// only way across a row without a mouse. Shift+Tab walks back. In the very last
// cell Tab grows the table by one row and puts the caret in its first cell, the
// way Word does, so a table can be filled in without leaving the keyboard.
// preventDefault either way: the browser's own Tab would leave the paragraph
// for the next focusable thing on the page, mid-sentence as it were.
blocksContainer.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const editor = e.target.closest('.rt-editor');
  if (!editor) return;
  const sel = window.getSelection();
  let node = sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
  if (node && node.nodeType !== 1) node = node.parentElement;
  const cell = node && node.closest ? node.closest('td, th') : null;
  if (!cell || !editor.contains(cell)) return;
  e.preventDefault();
  const table = cell.closest('table');
  const cells = [...table.rows].flatMap((r) => [...r.cells]);
  const i = cells.indexOf(cell);
  if (e.shiftKey) {
    if (i > 0) rtCaretToCell(cells[i - 1]);
  } else if (i < cells.length - 1) {
    rtCaretToCell(cells[i + 1]);
  } else {
    const added = rtTableAddRow(table, 'below', table.rows[table.rows.length - 1]);
    rtCaretToCell(added.cells[0]);
  }
  syncEditorToBlock(editor);
  saveRtSelection(editor);
});

// Whether the caret sits at the very end of `el`'s own content - collapsed,
// and nothing but empty text between it and el's last descendant. Used below
// to tell "the author is still typing" from "the author is trying to leave",
// which for a trailing structural block (a code block, a quotation) with
// nothing after it are the only two things a lone Enter press can mean.
function rtCaretAtEndOfEl(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return false;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return false;
  const tail = range.cloneRange();
  tail.selectNodeContents(el);
  tail.setStart(range.endContainer, range.endOffset);
  return tail.toString().length === 0;
}

// Leaves a trailing structural block the same way pressing Enter on an
// already-empty last line does in Word/Docs/Notion/GitHub: a fresh, empty
// paragraph appears right after it and the caret moves there. Both callers
// below exist because, without this, a code block or a quotation left at the
// END of a paragraph - nothing typed after it yet - had NO way out at all
// except reaching for the mouse and clicking below the block, which is what
// prompted this fix: a reader could type a command or a quote and then find
// themselves stuck inside it. A DOM write, not execCommand: there is no
// command that means "leave this element", the same reason rtWrapInQuote()/
// rtUnwrapQuote() above are DOM writes too.
function rtExitBlock(blockEl, editor, trailingEmptyLine) {
  if (!blockEl) return;
  if (trailingEmptyLine && trailingEmptyLine !== blockEl && trailingEmptyLine.parentNode) {
    trailingEmptyLine.remove();
  }
  const p = document.createElement('p');
  p.appendChild(document.createElement('br'));
  blockEl.after(p);
  const range = document.createRange();
  range.setStart(p, 0);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  syncEditorToBlock(editor);
  saveRtSelection(editor);
}

// Inserts a literal text node at the caret and leaves the caret collapsed
// right after it. Used below instead of execCommand('insertText', ...) -
// tested directly against a live editor: inside this <pre>, insertText's
// idea of "a line break" is a <br> element, not the character '\n', which
// breaks two things at once. white-space: pre-wrap (editorial.css) is what
// makes a plain '\n' character in the text itself render as a line break at
// all - a <br> works too, visually, but then .textContent (what "Sao chép"
// on the published post reads, and what the exit check below reads) never
// actually contains the newline: a <br> contributes nothing to it. The exit
// check was written expecting a real '\n' and, against the <br> insertText
// was actually producing, could never see one - the block could be typed
// into forever but the "press Enter again to leave" half never fired.
function rtInsertPlainTextAtCaret(text) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

// Enter inside a code block's command area writes a literal newline instead
// of splitting into a new paragraph. A <pre> is one block of preformatted
// text - the browser's own Enter (which inserts a fresh <div>/<p> the same
// way it does anywhere else the caret could be) would fragment a multi-line
// command into a separate paragraph per line, breaking both the look of the
// block and what "Sao chép" reads off it. A DOM write
// (rtInsertPlainTextAtCaret), not execCommand - see that function's own
// comment for why insertText specifically does not work here.
// The one exception is the exit case just above: Enter on a line that is
// ALREADY empty (the author's second consecutive press) leaves the block
// instead of piling up a blank line nobody can see - a <pre> gives no visual
// feedback that anything even happened, which combined with intercepting
// EVERY Enter meant a code block at the end of a paragraph had no way out.
blocksContainer.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const editor = e.target.closest('.rt-editor');
  if (!editor) return;
  const sel = window.getSelection();
  let node = sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
  if (node && node.nodeType !== 1) node = node.parentElement;
  const codeBody = node && node.closest ? node.closest('.rt-code-body') : null;
  if (!codeBody) return;
  e.preventDefault();
  if (rtCaretAtEndOfEl(codeBody) && /\n$/.test(codeBody.textContent)) {
    rtExitBlock(codeBody.closest('.rt-code'), editor);
    return;
  }
  rtInsertPlainTextAtCaret('\n');
  syncEditorToBlock(editor);
});

// Enter on an EMPTY line that is also the LAST line of a quotation exits it,
// the same double-Enter-to-leave convention as the code block above and
// every other block editor. Every other Enter inside a quote - the common
// case, still writing the quoted sentence - is left alone entirely: the
// browser's own paragraph-splitting already does the right thing there, the
// same as it does for a plain paragraph, so this only ever intercepts the
// one keystroke that would otherwise leave the author stuck with a
// quotation and nothing after it.
blocksContainer.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const editor = e.target.closest('.rt-editor');
  if (!editor) return;
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType !== 1) node = node.parentElement;
  const bq = node && node.closest ? node.closest('blockquote.' + RT_QUOTE_CLASS) : null;
  if (!bq || !editor.contains(bq)) return;
  const line = rtCurrentBlock(editor); // the innermost line, or the quote itself if bare
  const isLastLine = line === bq || line === bq.lastElementChild;
  const isEmpty = !line || !line.textContent.trim();
  if (!isLastLine || !isEmpty) return; // still writing the quote - browser handles it
  e.preventDefault();
  rtExitBlock(bq, editor, line !== bq ? line : null);
});

// Ctrl+K opens the link dialog - Word's shortcut, the habit that reaches for a
// link before the toolbar does. Only while a paragraph is being edited, so the
// same chord still works in the browser's own fields elsewhere on the page.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k') return;
  const editor = activeRtEditor();
  if (!editor) return;
  e.preventDefault();
  saveRtSelection(editor);
  openRtLink();
});

// ---- Page init ----
async function init() {
  // The rich-text engine above (docked toolbar, menus, execCommand wrappers) is
  // page-agnostic - /terms.html loads this file so its clause editor gets the
  // very same formatting - but the page wiring below is not. Bail before the
  // first post-form lookup on any page that has no post form.
  if (!document.getElementById('post-form')) return;
  if (!Auth.isLoggedIn()) {
    document.getElementById('not-logged-in').classList.remove('hidden');
    document.getElementById('not-logged-in').classList.add('flex');
    return;
  }
  const user = Auth.getUser();
  if (user && user.role === 'readonly') {
    document.getElementById('not-writer').classList.remove('hidden');
    document.getElementById('not-writer').classList.add('flex');
    return;
  }

  document.getElementById('editor-main').classList.remove('hidden');
  document.getElementById('editor-main').classList.add('flex', 'flex-col');
  renderBlocks();

  if (editId) {
    document.getElementById('editor-heading').textContent = 'Chỉnh sửa bài viết';
    try {
      let post = null;
      const mine = await API.listPosts({ mine: 'true', limit: 50 });
      post = mine.posts.find((p) => p.id === Number(editId));
      if (!post && user.role === 'admin') {
        const all = await API.adminPosts();
        post = all.posts.find((p) => p.id === Number(editId));
      }
      if (!post) throw new Error('Không tìm thấy bài viết hoặc bạn không có quyền sửa.');

      // The list endpoints above no longer carry `content` - a card needs none
      // of it, and shipping every article's block JSON to draw a title was the
      // single biggest waste in the API. The editor is the one caller that does
      // need the body, so it re-reads just this post through the single-post
      // route, which returns everything and re-checks owner/admin on the way in.
      const full = await API.getPost(post.slug);
      post = full.post || post;
      editingPost = post;

      const form = document.getElementById('post-form');
      form.title.value = post.title;
      form.tag.value = post.tag;
      document.getElementById('cover-url-input').value = post.cover_image || '';
      if (post.cover_image) setCoverImage(post.cover_image);
      // Not form.excerpt.value: the field is contenteditable now, not a form
      // control, so FormData never sees it either - see buildPostPayload()
      // below, which reads the same element's innerHTML instead of fd.get().
      const excerptEditor = document.getElementById('post-excerpt-input');
      if (excerptEditor) {
        excerptEditor.innerHTML = post.excerpt || '';
        excerptEditor.classList.toggle('is-empty', !excerptEditor.textContent.trim());
      }
      form.draft.checked = post.status === 'draft';
      // post.hashtags here is already a real array - GET /api/posts/:slug
      // (server/routes/posts.js withAuthor()) parses the DB's JSON column
      // before this ever reaches the client. JSON.parse()-ing it again threw
      // (an array coerces to a bare comma-joined string, which is not valid
      // JSON), was swallowed by the catch below, and silently reset every
      // existing post's hashtags to empty the moment it was opened for
      // editing - gone from the input on load, and gone from the DB for real
      // the next time autosave or "Lưu bài viết" sent that now-empty field back.
      const existingHashtags = Array.isArray(post.hashtags) ? post.hashtags : [];
      document.getElementById('post-form').hashtags_input.value = existingHashtags.join(', ');
      renderHashtagsPreview(existingHashtags);

      // Load existing content into the block editor (auto-upgrades legacy plain-text posts)
      blocks = parseContentBlocks(post.content).map((b) => ({ ...migrateBlockForEditing(b), key: nextBlockKey++ }));
      renderBlocks();
    } catch (e) {
      document.getElementById('form-error').textContent = e.message;
      document.getElementById('form-error').classList.remove('hidden');
    }
  }

  // Only from here on does the form reflect either a blank editor or a fully
  // loaded existing post - never content still on its way in, which the timer
  // above would otherwise be free to "helpfully" save over mid-load. The
  // baseline snapshot is today's content, so the first tick only fires once
  // something actually changes, not on the load itself.
  autosaveArmed = true;
  const { payload, cleanBlocks } = buildPostPayload(document.getElementById('post-form'));
  if (autosaveHasContent(payload, cleanBlocks)) {
    if (!editingPost) payload.status = 'draft';
    autosaveSnapshot = JSON.stringify(payload);
  }
}

function parseHashtagsInput(value) {
  return String(value || '')
    .split(',')
    .map((t) => t.trim().replace(/^#/, ''))
    .filter(Boolean);
}

function renderHashtagsPreview(tags) {
  const el = document.getElementById('hashtags-preview');
  el.innerHTML = tags
    .map((t) => `<span class="bg-surface-container text-on-surface-variant px-3 py-1 rounded-full text-label-md font-label-md">#${escapeHtml(t)}</span>`)
    .join('');
}

// The hashtags preview and the submit handler belong to the write page, not to
// the rich-text engine above it - /terms.html loads this file for the engine
// alone, where neither element exists. Optional-chained so the file survives a
// page without a post form instead of dying half-wired.
document.getElementById('post-form')?.hashtags_input?.addEventListener('input', (e) => {
  renderHashtagsPreview(parseHashtagsInput(e.target.value));
});

// ---- Tag picker ----
// The "Thẻ" field is a combobox over the tags already used by published posts
// (GET /api/posts/tags, the same list as the chips on /viewall.html). A tag
// that does not exist yet is simply typed: the list offers "Tạo thẻ mới", and
// once the post is saved the tag is a normal post.tag, so it shows up in this
// list and in the chips from then on. The input stays the form field itself.
function initTagCombo() {
  const combo = document.getElementById('tag-combo');
  const input = document.getElementById('post-tag-input');
  const list = document.getElementById('tag-combo-list');
  if (!combo || !input || !list) return;
  let tags = [];
  let active = -1;
  const fold = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();

  const isAdmin = typeof Auth !== 'undefined' && Auth.isAdmin();
  const loadTags = () =>
    API.listTags()
      .then((r) => { tags = Array.isArray(r?.tags) ? r.tags : []; if (!list.classList.contains('hidden')) render(); })
      .catch(() => {});
  loadTags();

  const options = () => [...list.querySelectorAll('.tag-combo-option')];
  const setActive = (i) => {
    const opts = options();
    active = opts.length ? (i + opts.length) % opts.length : -1;
    opts.forEach((o, n) => o.setAttribute('aria-selected', String(n === active)));
    opts[active]?.scrollIntoView({ block: 'nearest' });
  };
  function render() {
    const q = input.value.trim();
    const fq = fold(q);
    const hits = tags.filter((t) => !fq || fold(t.tag).includes(fq));
    const exact = tags.some((t) => fold(t.tag) === fq);
    let html = hits
      .map((t) => `<li class="tag-combo-option" role="option" aria-selected="false" data-value="${escapeHtml(t.tag)}"><span>${escapeHtml(t.tag)}</span><span class="tag-combo-count">${t.count}</span>${
        isAdmin
          ? `<button type="button" class="tag-combo-act" data-tag-act="rename" tabindex="-1" title="Đổi tên thẻ (áp dụng cho mọi bài viết)">Sửa</button><button type="button" class="tag-combo-act is-danger" data-tag-act="delete" tabindex="-1" title="Xoá thẻ (các bài viết chuyển về Chung)">Xoá</button>`
          : ''
      }</li>`)
      .join('');
    if (q && !exact) {
      html += `<li class="tag-combo-option tag-combo-new" role="option" aria-selected="false" data-value="${escapeHtml(q)}"><span class="tag-combo-plus" aria-hidden="true">+</span><span>Tạo thẻ mới “${escapeHtml(q)}”</span></li>`;
    }
    if (!html) html = '<li class="tag-combo-empty">Chưa có thẻ nào - gõ để tạo thẻ mới</li>';
    list.innerHTML = html;
    active = -1;
  }
  const open = () => { render(); list.classList.remove('hidden'); input.setAttribute('aria-expanded', 'true'); };
  const close = () => { list.classList.add('hidden'); input.setAttribute('aria-expanded', 'false'); active = -1; };
  const choose = (li) => { input.value = li.dataset.value; close(); input.dispatchEvent(new Event('change', { bubbles: true })); };

  input.addEventListener('focus', open);
  input.addEventListener('input', open);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.classList.contains('hidden')) open();
      setActive(active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' && !list.classList.contains('hidden')) {
      // Never submit the post from the tag field.
      e.preventDefault();
      const li = options()[active];
      if (li) choose(li); else close();
    } else if (e.key === 'Escape' && !list.classList.contains('hidden')) {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      close();
    }
  });
  // mousedown, not click: keeps focus in the input so blur does not close the
  // list before the choice lands.
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('.tag-combo-option');
    e.preventDefault();
    const act = e.target.closest('[data-tag-act]');
    if (act && li) { editTag(act.dataset.tagAct, li.dataset.value); return; }
    if (li) choose(li);
  });

  // Admins: rename / delete an existing tag across every post (PATCH/DELETE
  // /api/posts/tags). The dialogs take focus, so the list closes first.
  let editing = false;
  async function editTag(action, tag) {
    if (editing) return;
    editing = true;
    close();
    try {
      if (action === 'rename') {
        const to = await uiPrompt(`Đổi tên thẻ "${tag}" thành:`, { value: tag, confirmText: 'Đổi tên' });
        if (!to || to === tag) return;
        const r = await API.renameTag(tag, to);
        if (input.value.trim().toLowerCase() === tag.toLowerCase()) input.value = r.tag || to;
        uiAlert(`Đã đổi tên thẻ trong ${r.changed} bài viết.`, { icon: 'check_circle' });
      } else {
        if (!(await uiConfirm(`Xoá thẻ "${tag}"? Các bài viết đang dùng thẻ này sẽ chuyển về thẻ "Chung".`, { confirmText: 'Xoá' }))) return;
        const r = await API.deleteTag(tag);
        if (input.value.trim().toLowerCase() === tag.toLowerCase()) input.value = 'Chung';
        uiAlert(`Đã xoá thẻ. ${r.changed} bài viết chuyển về "Chung".`, { icon: 'check_circle' });
      }
      await loadTags();
    } catch (err) {
      uiAlert(err.message || 'Không sửa được thẻ.', { icon: 'error' });
    } finally {
      editing = false;
    }
  }
  combo.querySelector('.tag-combo-toggle')?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (list.classList.contains('hidden')) { input.focus(); open(); } else close();
  });
  input.addEventListener('blur', close);
}
initTagCombo();

// ---- Cover-image cropper ----
// Same drag-to-move/drag-corner-to-resize/canvas-export mechanism as
// profile.js's openCropper() (avatar/cover) and admin.js's openHeroCropper() -
// ported rather than shared, per those two's own comments on why a third copy
// is simpler here than a parameter-heavy shared module. One ratio, not
// several: a post has exactly one cover, shown at exactly one shape
// everywhere it appears (.ed-lead-media on the homepage/mosaic grid, .ed-cover
// on the article page itself - both editorial.css), so unlike profile.js's
// version (avatar=1, cover=2.4, picked per call) this one needs no ratio
// parameter at all.
const COVER_CROP_RATIO = 1200 / 630; // matches .ed-lead-media/.ed-cover's aspect-ratio: 40 / 21

let coverCropState = null; // { pendingFile, rect, mode, pointerStart, rectStart, onDone }

function coverCropEls() {
  return {
    modal: document.getElementById('cover-crop-modal'),
    img: document.getElementById('cover-crop-img'),
    box: document.getElementById('cover-crop-box'),
    error: document.getElementById('cover-crop-error'),
    apply: document.getElementById('cover-crop-apply'),
    cancel: document.getElementById('cover-crop-cancel'),
    useOriginal: document.getElementById('cover-crop-use-original'),
  };
}

function setCoverCropError(text) {
  const { error } = coverCropEls();
  if (!error) return;
  error.textContent = text || '';
  error.classList.toggle('hidden', !text);
}

// `onDone(file)` is called once, with either the cropped image or - if
// "Dùng ảnh gốc" was pressed - the original `file` untouched; the caller
// uploads either one the same way, so it never needs to know which happened.
function openCoverCropper({ file, onDone }) {
  const els = coverCropEls();
  if (!els.modal || !els.img || !els.box) {
    onDone(file); // older cached page with no modal markup: skip straight to upload
    return;
  }
  setCoverCropError('');
  els.apply.disabled = true; // re-enabled once the picture is actually on screen
  coverCropState = { pendingFile: file, rect: null, mode: null, onDone };

  // The frame starts as the largest rectangle of the locked ratio, centred in
  // the picture - confirming immediately keeps everything when the image
  // already matches that shape, and crops symmetrically when it does not.
  const finishOpen = () => {
    if (!coverCropState) return;
    els.apply.disabled = false;
    const imgW = els.img.offsetWidth;
    const imgH = els.img.offsetHeight;
    const w = Math.min(imgH * COVER_CROP_RATIO, imgW);
    const h = w / COVER_CROP_RATIO;
    coverCropState.rect = { x: (imgW - w) / 2, y: (imgH - h) / 2, w, h };
    renderCoverCropBox();
  };

  els.img.onload = finishOpen;
  els.img.onerror = () => setCoverCropError('Không đọc được tệp ảnh này.');
  // data: URL rather than URL.createObjectURL(): the CSP is
  // img-src 'self' data: https: with no blob: scheme, so a blob URL never
  // paints, and data: draws onto the crop canvas untainted just the same.
  const reader = new FileReader();
  reader.onload = () => {
    els.img.src = reader.result;
  };
  reader.onerror = () => setCoverCropError('Không đọc được tệp ảnh này.');
  reader.readAsDataURL(file);

  els.modal.classList.remove('hidden');
  els.modal.classList.add('flex');
}

function closeCoverCropper() {
  const els = coverCropEls();
  coverCropState = null;
  if (els.modal) {
    els.modal.classList.add('hidden');
    els.modal.classList.remove('flex');
  }
  if (els.img) {
    els.img.onload = els.img.onerror = null;
    els.img.removeAttribute('src');
  }
}

function renderCoverCropBox() {
  const els = coverCropEls();
  const rect = coverCropState?.rect;
  if (!els.box || !rect) return;
  els.box.style.left = `${rect.x}px`;
  els.box.style.top = `${rect.y}px`;
  els.box.style.width = `${rect.w}px`;
  els.box.style.height = `${rect.h}px`;
}

// Pointer events cover mouse and touch alike. Captured on the box so a fast
// drag keeps working even when the pointer runs ahead of the frame.
function initCoverCropPointer() {
  const els = coverCropEls();
  if (!els.box || !els.img) return;
  const MIN = 32; // px of crop width - anything smaller is not worth keeping

  els.box.addEventListener('pointerdown', (e) => {
    if (!coverCropState?.rect) return;
    e.preventDefault();
    coverCropState.mode = e.target.dataset.cropHandle ? `resize-${e.target.dataset.cropHandle}` : 'move';
    coverCropState.pointerStart = { x: e.clientX, y: e.clientY };
    coverCropState.rectStart = { ...coverCropState.rect };
    els.box.setPointerCapture(e.pointerId);
  });

  els.box.addEventListener('pointermove', (e) => {
    const st = coverCropState;
    if (!st?.mode || !st.rectStart) return;
    const dx = e.clientX - st.pointerStart.x;
    const dy = e.clientY - st.pointerStart.y;
    const imgW = els.img.offsetWidth;
    const imgH = els.img.offsetHeight;
    const r = { ...st.rectStart };

    if (st.mode === 'move') {
      r.x = Math.min(Math.max(r.x + dx, 0), Math.max(imgW - r.w, 0));
      r.y = Math.min(Math.max(r.y + dy, 0), Math.max(imgH - r.h, 0));
    } else {
      // Locked ratio: derive the new width from whichever axis moved further
      // (so diagonal drags feel 1:1), re-derive the height, and keep the
      // corner OPPOSITE the drag pinned in place.
      const corner = st.mode.slice('resize-'.length); // nw | ne | sw | se
      const rs = st.rectStart;
      const anchorR = rs.x + rs.w; // fixed right edge when dragging a w corner
      const anchorB = rs.y + rs.h; // fixed bottom edge when dragging an n corner
      const wFromX = corner.includes('e') ? rs.w + dx : rs.w - dx;
      const wFromY = (corner.includes('s') ? rs.h + dy : rs.h - dy) * COVER_CROP_RATIO;
      let w = Math.abs(dx) >= Math.abs(dy) ? wFromX : wFromY;
      const maxW = Math.min(
        corner.includes('w') ? anchorR : imgW - rs.x, // horizontal room
        (corner.includes('n') ? anchorB : imgH - rs.y) * COVER_CROP_RATIO // vertical room
      );
      w = Math.min(Math.max(w, MIN), maxW);
      r.w = w;
      r.h = w / COVER_CROP_RATIO;
      r.x = corner.includes('w') ? anchorR - w : rs.x;
      r.y = corner.includes('n') ? anchorB - r.h : rs.y;
    }
    st.rect = r;
    renderCoverCropBox();
  });

  const endDrag = () => {
    if (coverCropState) coverCropState.mode = null;
  };
  els.box.addEventListener('pointerup', endDrag);
  els.box.addEventListener('pointercancel', endDrag);
}

async function applyCoverCrop() {
  const els = coverCropEls();
  const st = coverCropState;
  if (!st?.rect) return;
  const img = els.img;
  setCoverCropError('');
  els.apply.disabled = true;

  try {
    // Displayed px -> native px, then cap the export so a very large original
    // still sails under the upload route's 8 MB cap.
    const scale = img.naturalWidth / img.offsetWidth;
    const sx = Math.round(st.rect.x * scale);
    const sy = Math.round(st.rect.y * scale);
    const sw = Math.round(st.rect.w * scale);
    const sh = Math.round(st.rect.h * scale);
    const MAX_SIDE = 2000;
    const longest = Math.max(sw, sh);
    const k = longest > MAX_SIDE ? MAX_SIDE / longest : 1;
    const outW = Math.max(1, Math.round(sw * k));
    const outH = Math.max(1, Math.round(sh * k));

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);

    // PNG (and GIF, which a canvas can only save as a still frame) keeps
    // transparency; photographs go out as high-quality JPEG.
    const keepPng = /png|gif/i.test(st.pendingFile?.type || '');
    const type = keepPng ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Trình duyệt không xuất được ảnh đã cắt.'))),
        type,
        0.92
      );
    });
    const file = new File([blob], keepPng ? 'crop.png' : 'crop.jpg', { type });
    const onDone = st.onDone;
    closeCoverCropper();
    onDone(file);
  } catch (err) {
    els.apply.disabled = false;
    setCoverCropError(err.message || 'Không cắt được ảnh này.');
  }
}

(function initCoverCrop() {
  const els = coverCropEls();
  if (!els.modal) return;
  initCoverCropPointer();
  els.apply.addEventListener('click', applyCoverCrop);
  els.cancel.addEventListener('click', closeCoverCropper);
  els.useOriginal.addEventListener('click', () => {
    const st = coverCropState;
    if (!st) return;
    const onDone = st.onDone;
    const file = st.pendingFile;
    closeCoverCropper();
    onDone(file);
  });
})();

// ---- Cover image: click-to-browse AND drag-and-drop from the file explorer ----
const COVER_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

async function uploadCoverImage(file) {
  const status = document.getElementById('cover-upload-status');
  status.classList.remove('hidden');

  // Same whitelist the server enforces in routes/upload.js - checking here
  // too gives instant feedback instead of a round-trip that ends in a 400.
  if (!COVER_ALLOWED_TYPES.includes(file.type)) {
    status.textContent = 'Chỉ chấp nhận ảnh JPG, PNG, WEBP hoặc GIF.';
    return;
  }

  status.textContent = 'Đang tải ảnh lên...';
  try {
    // Library endpoint, same reasoning as the image blocks: no per-file limit for an
    // admin, and the cover ends up reusable from the library.
    const { url } = await API.uploadImage(file, {
      endpoint: '/media',
      onProgress: (ratio, loaded, total) => {
        status.textContent = `Đang tải lên ${Math.round(ratio * 100)}% (${formatUploadBytes(loaded)} / ${formatUploadBytes(total)})`;
      },
    });
    setCoverImage(url);
    status.textContent = 'Tải ảnh thành công!';
  } catch (err) {
    status.textContent = err.message;
  }
}

// One place that writes the cover field and its preview, so the upload path and the
// library path cannot end up disagreeing about which one to update.
function setCoverImage(url) {
  document.getElementById('cover-url-input').value = url;
  const preview = document.getElementById('cover-preview');
  preview.src = url;
  preview.classList.toggle('hidden', !url);
}

document.getElementById('cover-file-input')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  // Cleared immediately (not after cropping) so picking the SAME filename
  // again later - e.g. after cancelling this crop - still fires 'change'.
  // openCoverCropper() already holds its own reference to `file`, so this
  // does not affect the pick already in progress.
  e.target.value = '';
  if (file) openCoverCropper({ file, onDone: uploadCoverImage });
});

// "Chọn từ thư viện" under the cover field.
document.getElementById('cover-library-btn')?.addEventListener('click', async () => {
  if (typeof openMediaPicker !== 'function') return;
  const chosen = await openMediaPicker();
  if (!chosen) return;
  setCoverImage(chosen.url);
  const status = document.getElementById('cover-upload-status');
  status.textContent = 'Đã chọn ảnh từ thư viện.';
  status.classList.remove('hidden');
});

// Drag-and-drop. The whole label is the drop target; dragover must be
// cancelled or the browser navigates away to the dropped file instead.
const coverDropzone = document.getElementById('cover-dropzone');
const COVER_DRAG_ACTIVE = ['border-electric-indigo', 'bg-surface-variant'];

['dragenter', 'dragover'].forEach((evt) => {
  coverDropzone?.addEventListener(evt, (e) => {
    e.preventDefault();
    coverDropzone.classList.add(...COVER_DRAG_ACTIVE);
  });
});

['dragleave', 'drop'].forEach((evt) => {
  coverDropzone?.addEventListener(evt, (e) => {
    e.preventDefault();
    coverDropzone.classList.remove(...COVER_DRAG_ACTIVE);
  });
});

coverDropzone?.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) openCoverCropper({ file, onDone: uploadCoverImage });
});

// Dropping anywhere else on the page would make the browser leave the editor
// and open the file, silently losing unsaved work.
['dragover', 'drop'].forEach((evt) => {
  window.addEventListener(evt, (e) => {
    if (coverDropzone && !coverDropzone.contains(e.target)) e.preventDefault();
  });
});

document.getElementById('post-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('form-error');
  errorEl.classList.add('hidden');

  // An autosave tick may already be mid-flight when the author clicks "Lưu bài
  // viết" for real; the click is deliberate intent and waits its turn instead
  // of being dropped on the floor.
  if (autosaveInFlight) await autosaveInFlight.catch(() => {});

  // Pressing "Lưu bài viết" twice while the first save is in flight would create
  // the post twice, or send two updates that race each other.
  if (rtSaving) return;
  rtSaving = true;
  try {
    await submitPostForm(e.target, errorEl);
  } finally {
    rtSaving = false;
  }
});

// Whether a paragraph block has anything worth saving. Its words, or a picture in
// it: stripping tags to test for emptiness is right for words and wrong for an
// <img>, which is ALL markup - and "chèn ảnh vào đoạn văn" on a fresh paragraph
// produces exactly that, a block with a picture and no text at all. Only an <img>
// whose src the sanitizer keeps counts, so a paragraph left holding a stripped
// data: URL is still dropped as empty.
//
// The placeholder chip is neither, and is taken out before either test is applied.
// It is the promise of a picture, not one, and its label is not something the
// author wrote: a save forced through while an upload was somehow still
// outstanding - a hung request the browser has not yet given up on - must not
// count "Đang tải ảnh lên 40%" as four words of prose, nor keep an otherwise empty
// paragraph alive on the chip's account. submitPostForm() waits on the uploads
// first, so this is the belt to that brace.
function rtParagraphHasContent(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  for (const chip of tpl.content.querySelectorAll('.rt-inline-pending')) chip.remove();
  // The same two tests the filter has always applied, in the same spelling - the
  // words are what is left with the tags stripped - so nothing that saved before
  // this stops saving now.
  return !!(
    tpl.innerHTML.replace(/<[^>]*>/g, '').trim() ||
    [...tpl.content.querySelectorAll('img')].some((img) => rtImgSrcSurvives(img.getAttribute('src'))) ||
    // A table is content with every cell still empty: the grid the author built
    // is the point, and the words may be on their way into it. Without this a
    // table-only paragraph - no text once the tags are stripped, no picture -
    // was the one block shape the two older tests could not see, and save
    // dropped it.
    tpl.content.querySelector('table')
  );
}

function rtBlockWorthSaving(b) {
  if (b.type === 'image') return !!b.url;
  if (b.type === 'layout') return imageLayoutImages(b).length > 0;
  // An unresolved embed is dropped rather than saved: without a src it renders
  // nothing, so keeping it would store a block the reader never sees.
  if (b.type === 'embed') return !!b.src;
  if (b.type === 'paragraph') return rtParagraphHasContent(b.html);
  return !!(b.text && b.text.trim()); // heading
}

let rtSaving = false;

// One last read of every editor, and the fields into a save-ready payload -
// shared by the save button and the autosave timer below so the two can
// never disagree about what "the current post" contains. An <img> swapped in
// for a chip is written to the DOM and to the model, but a paragraph the
// author is still typing in has only been synced as far as its last input
// event until syncEditorToBlock() runs.
function buildPostPayload(form) {
  for (const editor of blocksContainer.querySelectorAll('.rt-editor')) syncEditorToBlock(editor);

  const fd = new FormData(form);

  const cleanBlocks = blocks
    .map(({ key, ...rest }) => rest)
    // rtStripDeadImages() first, and deliberately before the typography pass: an
    // <img> whose src the sanitizer would blank is not a picture, it is a hole, and
    // normalizeRichTextHtml() has no opinion about either. A block the author never
    // re-rendered and never typed into would otherwise carry its dead <img> to the
    // server, which would store `<img alt="">` and render nothing.
    //
    // The editor's indent is a <blockquote> (the only element the native
    // indent/outdent commands understand); what gets STORED is a plain
    // <div class="rt-indent">, so the reading page never paints an indented
    // paragraph as a pull-quote. See normalizeRichTextHtml() in js/api.js.
    .map((b) =>
      (b.type === 'paragraph' || b.type === 'layout') && b.html !== undefined
        ? { ...b, html: normalizeRichTextHtml(rtStripDeadImages(b.html)) }
        : b
    )
    // A layout keeps only its real pictures, and only the text its kind shows.
    .map((b) => {
      if (b.type !== 'layout') return b;
      const out = { ...b, images: (b.images || []).filter((im) => im && im.url) };
      if (!imageLayoutDef(b.layout).text) delete out.html;
      return out;
    })
    .filter(rtBlockWorthSaving);

  // Not fd.get('excerpt'): the field is contenteditable, not a form control
  // (see initExcerptEditor()), so FormData never picks it up - its innerHTML
  // is read directly instead, the same way a block's own .rt-editor is read
  // via syncEditorToBlock() above. The server re-sanitizes it regardless
  // (sanitizeRichHtml, server/routes/posts.js), so nothing extra is done to
  // it here.
  const excerptEditor = document.getElementById('post-excerpt-input');
  const payload = {
    title: fd.get('title'),
    tag: fd.get('tag') || 'Chung',
    hashtags: parseHashtagsInput(fd.get('hashtags_input')),
    cover_image: document.getElementById('cover-url-input').value,
    excerpt: excerptEditor ? excerptEditor.innerHTML : '',
    content: JSON.stringify(cleanBlocks),
  };

  return { payload, cleanBlocks, isDraftChecked: !!fd.get('draft') };
}

async function submitPostForm(form, errorEl) {
  // Pictures still on their way up are waited for rather than refused: the author
  // pressed "Lưu bài viết", the bytes are already mostly sent, and making them
  // press it again is a worse answer than a short pause. Saving NOW would store
  // the placeholder chip - or nothing at all, since a paragraph whose only content
  // is a chip counts as empty.
  if (rtPendingUploads.size) {
    const n = rtPendingUploads.size;
    errorEl.textContent = `Đang tải ${n} ảnh lên — bài viết sẽ được lưu ngay khi xong...`;
    errorEl.classList.remove('text-error');
    errorEl.classList.remove('hidden');
    rtUploadFailures = 0;
    await Promise.allSettled([...rtPendingUploads]);
    errorEl.classList.add('hidden');
    errorEl.classList.add('text-error');
    if (rtUploadFailures) {
      errorEl.textContent = `${rtUploadFailures} ảnh không tải lên được và đã bị bỏ qua. Bài viết vẫn được lưu với phần còn lại.`;
      errorEl.classList.remove('hidden');
    }
  }

  // Read the fields AFTER any upload wait, not before: if the save had to
  // pause, the author spent that wait looking at the form, and a title they
  // corrected in the meantime is the one they meant.
  const { payload, cleanBlocks, isDraftChecked } = buildPostPayload(form);

  if (!cleanBlocks.length) {
    errorEl.textContent = 'Vui lòng thêm ít nhất một khối văn bản hoặc ảnh cho nội dung bài viết.';
    errorEl.classList.remove('hidden');
    return;
  }

  payload.status = isDraftChecked ? 'draft' : 'published';

  try {
    let post;
    if (editingPost) {
      ({ post } = await API.updatePost(editingPost.id, payload));
    } else {
      ({ post } = await API.createPost(payload));
    }
    // Nothing left for the timer below to catch up on before the page unloads.
    autosaveSnapshot = JSON.stringify(payload);
    window.location.href = `/post.html?slug=${post.slug}`;
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
}

// ---- Autosave ----
// A post is easiest to lose before it has ever been saved once: nothing has
// reached the server yet, and a closed tab, a crashed browser, or a phone call
// erases everything typed so far - including everything typed before the
// author has gotten around to a title. This writes the current draft to the
// server in the background on a timer, without waiting for "Lưu bài viết".
//
// It only ever writes a draft, never a publish - publishing is something the
// author does on purpose with the button, never something a timer decides for
// them - and it always steps aside for a real save rather than racing it: see
// the `rtSaving`/`autosaveInFlight` checks below and in the submit listener
// above.
const AUTOSAVE_INTERVAL_MS = 15000;
let autosaveArmed = false; // true once init() has finished loading (or decided there is nothing to load)
let autosaveSnapshot = null; // JSON of the payload as of the last successful save, auto or manual
let autosaveInFlight = null; // the current autosave tick's promise, or null between ticks
const autosaveStatusEl = document.getElementById('autosave-status');

function setAutosaveStatus(text) {
  if (autosaveStatusEl) autosaveStatusEl.textContent = text;
}

// Whether there is anything a background save is worth bothering the server
// with yet - a blank new post has nothing to lose, and autosaving it would
// only litter the drafts list with empty rows.
function autosaveHasContent(payload, cleanBlocks) {
  return !!(
    cleanBlocks.length ||
    payload.title.trim() ||
    payload.excerpt.trim() ||
    payload.cover_image ||
    payload.hashtags.length
  );
}

async function runAutosave() {
  if (!autosaveArmed || rtSaving || autosaveInFlight || rtPendingUploads.size) return;

  const form = document.getElementById('post-form');
  const { payload, cleanBlocks } = buildPostPayload(form);
  if (!autosaveHasContent(payload, cleanBlocks)) return;

  // Leaving `status` out of an update keeps whatever the post's current
  // status already is, draft or published - so autosaving a post that was
  // already live does not quietly unpublish it. A brand new post has no
  // existing status to preserve, so it starts life as a draft; only the
  // save button ever turns it into a publish.
  if (!editingPost) payload.status = 'draft';

  const snapshot = JSON.stringify(payload);
  if (snapshot === autosaveSnapshot) return; // nothing changed since the last save

  autosaveInFlight = (async () => {
    setAutosaveStatus('Đang lưu bản nháp...');
    try {
      let post;
      if (editingPost) {
        ({ post } = await API.updatePost(editingPost.id, payload));
      } else {
        ({ post } = await API.createPost(payload));
        editingPost = post;
        // So refreshing the tab - or reopening it after it was closed -
        // resumes this same draft instead of starting a second, empty one.
        history.replaceState(null, '', `/write.html?id=${post.id}`);
      }
      autosaveSnapshot = snapshot;
      const time = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
      setAutosaveStatus(`Đã lưu bản nháp lúc ${time}`);
    } catch (err) {
      setAutosaveStatus('Không thể lưu tự động, sẽ thử lại...');
    }
  })();
  try {
    await autosaveInFlight;
  } finally {
    autosaveInFlight = null;
  }
}

// ---- The excerpt field's own tiny toolbar (write.html) --------------------
// Three buttons, wired directly rather than through the big rt-dock/RT_TOOLBAR
// system above: that system opens for ANY focused .rt-editor and offers
// headings/tables/images, none of which belong on a one-line standfirst - see
// the comment on this field's own markup in write.html for why it does not
// carry that class. Bold/italic are plain execCommand, which is all a
// contenteditable needs for those two; the link button asks for a URL with a
// plain prompt() rather than reusing openRtLink()'s dialog, which is wired to
// activeRtEditor() and the rt-dock's own open/close state, not this field.
function excerptLinkUrl(existing) {
  const url = window.prompt('Địa chỉ liên kết (để trống để bỏ liên kết):', existing || 'https://');
  return url === null ? null : url.trim();
}

function initExcerptEditor() {
  const editor = document.getElementById('post-excerpt-input');
  if (!editor) return;
  const boldBtn = document.querySelector('[data-excerpt-cmd="bold"]');
  const italicBtn = document.querySelector('[data-excerpt-cmd="italic"]');

  const syncEmpty = () => editor.classList.toggle('is-empty', !editor.textContent.trim());
  editor.addEventListener('input', syncEmpty);
  syncEmpty();

  // Not routed through the shared syncRtToolbars() (activeRtEditor() only
  // ever looks for a .rt-editor, which this field deliberately is not - see
  // the markup comment) - a small selectionchange listener of its own
  // instead, scoped to firing only while the caret is actually in THIS
  // field, so it never touches the big toolbar's own buttons.
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    const inEditor = !!(sel && sel.anchorNode && editor.contains(
      sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement
    ));
    if (!inEditor) return;
    if (boldBtn) boldBtn.setAttribute('aria-pressed', String(document.queryCommandState('bold')));
    if (italicBtn) italicBtn.setAttribute('aria-pressed', String(document.queryCommandState('italic')));
  });

  for (const btn of document.querySelectorAll('[data-excerpt-cmd]')) {
    // mousedown, not click, prevented: the same reason the big toolbar's
    // buttons do this (see the document-level mousedown handler above) -
    // without it, focus moves to the button before execCommand runs and
    // there is no selection left for bold/italic to act on.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      editor.focus();
      const cmd = btn.dataset.excerptCmd;
      if (cmd === 'link') {
        const sel = window.getSelection();
        const inLink = sel && sel.anchorNode && sel.anchorNode.parentElement?.closest('a');
        const url = excerptLinkUrl(inLink ? inLink.href : '');
        if (url === null) return;
        if (url) document.execCommand('createLink', false, url);
        else document.execCommand('unlink');
      } else {
        document.execCommand(cmd);
        btn.setAttribute('aria-pressed', String(document.queryCommandState(cmd)));
      }
      syncEmpty();
    });
  }
}

setInterval(runAutosave, AUTOSAVE_INTERVAL_MS);

initExcerptEditor();
init();

// ---- Live preview (standard editor layout: Soạn thảo | Xem trước | Cài đặt) ----
// The middle column shows the post the way the reading page will: the title,
// the summary, then the blocks run through the same renderContentBlocksHtml()
// post.js uses. Refreshed a moment after any edit, and after renderBlocks()
// (adding, removing, moving a block, changing a layout).
let livePreviewTimer = null;
function updateLivePreview() {
  const box = document.getElementById('live-preview');
  if (!box) return;
  for (const editor of blocksContainer.querySelectorAll('.rt-editor')) syncEditorToBlock(editor);
  const title = document.getElementById('post-title-input')?.value.trim() || '';
  const excerpt = document.getElementById('post-excerpt-input')?.innerHTML.trim() || '';
  const clean = blocks
    .map(({ key, ...rest }) => rest)
    .map((b) =>
      (b.type === 'paragraph' || b.type === 'layout') && b.html !== undefined
        ? { ...b, html: normalizeRichTextHtml(rtStripDeadImages(b.html)) }
        : b
    )
    .filter(rtBlockWorthSaving);
  let body = '';
  try {
    body = renderContentBlocksHtml(clean);
  } catch {
    body = '';
  }
  box.innerHTML =
    (title ? `<h1 class="rt-live-title">${escapeHtml(title)}</h1>` : '<p class="rt-live-empty">Tiêu đề bài viết sẽ hiện ở đây.</p>') +
    (excerpt && excerpt !== '<br>' ? `<div class="rt-live-excerpt">${excerpt}</div>` : '') +
    (body ? `<div class="prose-content">${body}</div>` : '<p class="rt-live-empty">Nội dung bài viết sẽ hiện ở đây khi bạn thêm khối.</p>');
}
function scheduleLivePreview() {
  clearTimeout(livePreviewTimer);
  livePreviewTimer = setTimeout(updateLivePreview, 350);
}

// "Xem trước" in the Thêm khối bar: the preview column is hidden until asked
// for, and refreshed the moment it is opened.
document.getElementById('preview-toggle')?.addEventListener('click', (e) => {
  const form = document.getElementById('post-form');
  const on = !form.classList.contains('is-previewing');
  form.classList.toggle('is-previewing', on);
  e.currentTarget.setAttribute('aria-pressed', String(on));
  if (on) {
    updateLivePreview();
    // Below 1280px the preview sits under the editor, out of sight.
    if (window.matchMedia('(max-width: 1279px)').matches) {
      document.querySelector('#post-form > .rt-preview-col')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
});
document.getElementById('post-form')?.addEventListener('input', scheduleLivePreview);
document.getElementById('post-form')?.addEventListener('change', scheduleLivePreview);
// renderBlocks() is the one place every structural change goes through.
{
  const originalRenderBlocks = renderBlocks;
  // eslint-disable-next-line no-func-assign
  renderBlocks = function renderBlocksWithPreview(...args) {
    const out = originalRenderBlocks.apply(this, args);
    scheduleLivePreview();
    return out;
  };
}
scheduleLivePreview();
