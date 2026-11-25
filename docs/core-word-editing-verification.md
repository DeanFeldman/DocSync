# Core Word editing verification

Run the browser regression on Windows with Microsoft Edge installed:

```powershell
node scripts/smoke-structured-editing.mjs
```

The test starts a local API and browser with isolated data and uploads three sample agreements. It exercises the editor within Layout while the page preview is pending and after the preview fails. It checks typing, undo and redo, multiline paste, and draft recovery after switching documents while staging is unavailable. The first-input measurement is a single development-browser observation on the sample agreements.

The API tests cover reviewed generation, selected targets, rollback, conflicts, editable ranges, and version downloads. The cross-reference conversion test checks that displayed values become editable in place, the table and surrounding formatting survive import and download, and the original DOCX remains available in version history. The render-map tests cover split paragraphs and tables spanning pages.

## Packaged Windows release check

1. Launch a clean packaged build and create a workspace. Import a simple document, a table-heavy document with a cross-reference, a large document, and a related document set.
2. Compare the editable Layout view with the original in Microsoft Word. Check tables, numbering, spacing, headers, and footers. Try typing while the preview loads, editing a former cross-reference inside a table, and switching documents before staging.
3. Stage the edits, review their before-and-after wording in **Pending changes**, and include only the intended targets. Apply the batch and compare the updated Layout view with the downloaded DOCX opened in Microsoft Word. Check the edited text, nearby formatting, the untouched original version, and excluded documents.
4. Check that the first preview image loads, the remaining pages load as you scroll, and retrying the preview recovers from a render failure.
5. Use **Local data** to export a ZIP. On a separate clean installation, select **Import backup ZIP**, review the contents, and confirm. Compare documents, settings, and version history. Try an invalid ZIP and confirm the installed workspace is still available.
6. Record the hardware and fixture sizes. Measure cold and warm opening, first editable interaction, and input-to-paint latency. Compare the results with the performance targets in issue #50.

The packaged workflow, inspection in Microsoft Word, and representative performance measurements are release checks.
