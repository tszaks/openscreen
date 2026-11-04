# Security policy

## Supported versions

Only the latest release of OpenScreen gets security fixes. The app updates itself, so please make sure you are on the [latest release](https://github.com/tszaks/openscreen/releases/latest).

| Version | Supported |
|---|---|
| Latest release | Yes |
| Older | No |

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

Use GitHub private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. If that is not available to you, email tyler@szakacsmedia.com.

Please include:

- What you found and what an attacker could do with it.
- Steps to reproduce, or a sample project or video that triggers it.
- Your macOS version and OpenScreen version (OpenScreen > About OpenScreen).

You can expect a first reply within a few days. OpenScreen is maintained by a small team, so a fix may take longer, but you will get updates. Once a fix is released we will credit you in the release notes unless you prefer to stay anonymous.

## What counts

OpenScreen records your screen, camera and microphone, and reads recordings from disk. These areas matter most:

- Anything that records or reads data the user did not ask for, or sends it off the Mac.
- A project, imported video or edits file that runs code, reads files outside its bundle, or writes outside the recordings folder.
- The agent command line and the headless export path acting on files the user did not name.
- The update path (`electron-updater` and GitHub Releases) installing something that is not a signed release.
- Data loss: a bug that changes or deletes an original recording. Edits must only ever go to `project.json`.

See the FAQ in the [README](README.md#faq) for the network requests the app makes.
