# Markfine

[简体中文](README.md) | [English](README.en.md)

A small, responsive Markdown editor for macOS, designed for focused writing and immersive reading.

## Design philosophy

- **When writing, focus on your words.** Live formatting and keyboard-first controls let you write directly in the document layout and perform almost every writing action without leaving the keyboard.
- **When reading, focus on the content.** Editing controls and distractions fold away, leaving the outline and navigation you need for an immersive reading experience.

## Experience

### A lightweight native app

Built with native macOS frameworks and the system WebKit, without bundling a separate browser runtime. The download is small, no development tools are needed to run it, and one universal app supports both Intel and Apple Silicon.

### A responsive local experience

Designed with startup speed, typing responsiveness and smooth scrolling in mind. Text editing, Markdown layout and Mermaid rendering all happen on your Mac, without waiting for a remote service.

### Paragraph focus and smooth positioning

The paragraph you are editing stays clear while the rest fades into the background. As you write, the active paragraph moves smoothly toward the middle of the viewport; when you scroll manually, your chosen position is preserved.

### Write directly in the layout

Headings retain their size as you edit, and tables remain editable within their cells. Links normally show only their labels; moving the cursor into a link reveals its full syntax, which folds away again when you leave.

Switch to source mode to edit Markdown with syntax highlighting while keeping the same text, selection and undo history.

### Reading, whenever you need it

Reading mode folds away tabs and editing controls while keeping the document outline and zoom controls. Arrow keys scroll according to content structure, including paragraphs, lists, code and tables. Leave reading mode to resume editing where you were.

When you reopen a document, you can choose to return to your last editing or reading position.

### Work with whole chapters from the outline

Copy, cut or delete an entire chapter directly from the outline, including its subchapters. Cutting and deleting can be undone.

Copied content can include formatting and local images. When pasted into another Markfine document, the images are imported into that document's attachment directory.

Right-click an image to copy the original, the absolute path of a local image, or the link to a remote image.

In Live editing mode, click an image to edit its Markdown reference. The reference collapses when the caret leaves it.

### Edit diagrams with a live preview

When editing Mermaid, the source stays above the diagram. If the source contains an error, the last valid diagram remains visible with an error message.

Open a diagram in a larger view, zoom it independently and drag to explore without changing the document zoom. Use the preview toolbar to save the entire diagram as a PNG at 100% size. Flowcharts, sequence diagrams, class diagrams, state diagrams, ER diagrams and Gantt charts are all generated offline.

### Export and Quick Look

PDF exports include expandable, navigable heading bookmarks; Word exports retain heading levels for navigation. The bundled Finder extension can show formatted Markdown when you press Space. Mermaid appears as source, and local images depend on system access.

Exports default to the reading line spacing and Chinese / English fonts from Preferences. PDF and Word remember adjusted layouts separately after a successful export, and can be restored to follow Preferences.

Return Home without closing open documents or the folder. Remove recent locations individually or in batches, and choose how many to retain.

### Separate appearance settings for writing and reading

In light appearance, choose separate backgrounds for editing and reading: Pure white (default), textured Paper and Kraft paper, or Soft green. Dark appearance is also available.

Writing and reading have independent theme, line spacing and zoom settings. Chinese and Latin fonts can also be selected separately.

## Privacy and local processing

### Local by default

Text editing, Markdown layout, diagram generation and document export all happen on your Mac, without a cloud service. Documents stay in the locations you choose and remain under your control.

### No background reporting

Markfine does not include telemetry, usage analytics or cloud sync. It does not upload documents, usage records or diagnostic logs to the developer.

Settings and diagnostic logs are stored locally. Diagnostic logs do not record document text, file paths, links or credentials.

### Restricted external resources

Ordinary remote images, scripts and fonts referenced by documents are not loaded automatically. Websites you explicitly open are handed to your system browser.

### You choose where images are stored

Images are stored locally by default. Only after you explicitly configure S3-compatible storage does Markfine access that service to upload and retrieve images.

S3 credentials are stored in the system Keychain and are not exposed to the web-based editing layer. Apart from this explicitly configured image transfer, the client does not proactively call external network APIs.

## Platform and current status

Available for macOS as a universal app for Intel and Apple Silicon.

Markfine is currently a preview release. The app has not been notarized; after confirming that you trust its source, you may need to approve it using the macOS prompts on first launch.

## Documentation

- [User guide (Chinese)](docs/USAGE.md)
- [Keyboard shortcuts (Chinese)](docs/SHORTCUTS.md)
- [Building from source (Chinese)](docs/DEVELOPMENT.md)

## License

The project's own code and documentation are available under the [MIT License](LICENSE).

Third-party licenses are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
