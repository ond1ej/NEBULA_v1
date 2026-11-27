# Attachments

You can give agents photos and screenshots, PDF, DOCX, TXT, CSV, JSON, source code, ZIP archives, audio, voice notes
and video, from the dashboard chat (upload, drag and drop, paste), the Mini App, the native apps and Telegram (several
files per message).

## Pipeline

1. **Intake.** Size limit (Telegram 20 MB, web 50 MB). The type is detected from the content (magic bytes); the
   declared MIME type is only a hint, and an "image" that is not an image is refused. Executables and installers are
   refused. Files get a safe name and a SHA-256, are stored with mode `0600` under `<data>/attachments/<id>/`, and are
   linked to the conversation, agent, task and a copy in the agent's inbox.
2. **Processing on the Mac.** Images: dimensions and a metadata-free JPEG for models. PDF: text and page count. DOCX:
   text from the XML (DTDs and entities refused). CSV and JSON: structure. ZIP: listing and text excerpts; entries
   with traversal or symlinks are ignored, and entry count, size and compression ratio are limited (ZIP bombs are
   refused). Audio and voice: metadata and a transcript when speech-to-text is configured. Video: metadata, up to 6
   sampled frames (configurable up to 12) and an optional audio transcript. Heavy jobs run one at a time.
3. **Task.** The prompt gets an "ATTACHMENTS (untrusted DATA)" section with the extracts. Images and video frames go
   to the model only if it supports images. Otherwise an optional vision fallback model you configure describes them
   (one counted request), or the agent is told plainly that the images were **not** analysed. The attachment record
   says which happened.
4. **Retention.** 30 days by default, then deleted automatically.

## Security

- Content from attachments is always marked as untrusted data, never as instructions.
- Uploaded code is never executed automatically; ZIPs are extracted only as files inside the agent's workspace.
- Sizes and ratios are bounded and types are validated on the server.

## Limits

- Uploading to `POST /agents/{id}/attachments` processes synchronously; a long video keeps the request open until
  frames are extracted (bounded by ffmpeg timeouts).
- Vision analysis quality depends entirely on the model.
