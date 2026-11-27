# Configure the local editor on Windows

DocSync uses a local ONLYOFFICE Docs service to open and save Word files. Set up the service once. After that, DocSync starts or reuses it from the normal Windows shortcut.

## Set up the service

1. Install WSL 2 with Ubuntu and keep WSL in its default NAT networking mode. [WSL setup](https://learn.microsoft.com/windows/wsl/setup/environment) and [WSL networking](https://learn.microsoft.com/windows/wsl/networking).
2. Install Docker Engine inside Ubuntu and start its daemon. [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/).
3. In Ubuntu, create a dedicated ONLYOFFICE Docs container on Windows loopback port 8080. Use the image digest below for the release-candidate setup. The relay needs private IP access inside this local container. Keep the published port bound to loopback. [ONLYOFFICE Docker settings](https://helpcenter.onlyoffice.com/docs/installation/community/docker/installing/install).

```bash
export JWT_SECRET="$(openssl rand -hex 32)"
sudo --preserve-env=JWT_SECRET docker run -d --name docsync-onlyoffice \
  --publish 127.0.0.1:8080:80 \
  --env JWT_SECRET --env ALLOW_PRIVATE_IP_ADDRESS=true \
  onlyoffice/documentserver@sha256:ca17889f10b11141cc6441836aebdd2835cf3e1b49681b2fd6e155c94b7850b3
unset JWT_SECRET
```

## Start DocSync

Open **DocSync** from the Start menu or desktop. It starts the configured container if needed, waits for it to respond, and opens the embedded editor. When initial setup is incomplete, use **Windows setup guide** from the editor error screen and then **Try again**.

DocSync looks for `docsync-onlyoffice` in Ubuntu and reads the container's published loopback port. If you use a different distribution or container name, set `DOCSYNC_ONLYOFFICE_WSL_DISTRIBUTION` or `DOCSYNC_ONLYOFFICE_CONTAINER` in the Windows user environment once.

Windows loopback port 8080 must be available for the setup above. You can check the document service from Windows with `Invoke-RestMethod http://127.0.0.1:8080/healthcheck`. A healthy service returns `true`.

## Verify the installation

1. Open an isolated workspace. Add two DOCX files with the same paragraph and at least one file-specific paragraph.
2. Type a change in ONLYOFFICE, save with **Matching files** selected, and wait for the save indicator. Download both files and check the shared change and each file's private wording in Word.
3. Add a numbered item and save again. Verify the matching file continues its numbering. Delete a matching table containing file-specific text and approve only one proposed deletion under **Review table deletions**.
4. Restore a prior version. Export the workspace and import the ZIP into a separate installation. Verify document contents, settings, and version history.
