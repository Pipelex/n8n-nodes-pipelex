# Team Files

Your organization's files in Pipelex are the files its members uploaded (through the app, an SDK, this node's **Binary Inputs** or an agent), the test files the build assistant made, and the final outputs of its runs. It is the same list the app's Files page shows. The node reads it through its **File** resource: set **Resource** to **File**, then pick one of its operations.

| Operation | What it does | Endpoints | Output |
|---|---|---|---|
| **Download** (default) | Fetches one file's bytes as n8n binary data, found by its name or by its ID, to give it to another node. | `GET /v1/files?q=…` (by name) or `GET /v1/files/{file_id}` (by ID), then `POST /v1/files/links`, then the file's link | One item: the file's row as JSON and its bytes in a binary field |
| **Get Many** | Lists the files, newest first, with the platform's filters. | `GET /v1/files` (followed page by page) | One item per file |

Every role in the organization reads every file of it, so a key whose owner is a `runner` lists and downloads files like an `admin` does. The files are your organization's alone: another organization's files never appear, and another organization's file ID is answered as a file that does not exist.

> ℹ️ **Hosted-only:** the files routes are hosted-API extensions, not part of the bare MTHDS Protocol. A Base URL that serves no files routes fails the item saying so, and a backend of your own must serve `GET /v1/files`, `GET /v1/files/{file_id}` and `POST /v1/files/links` as the hosted API's files contract defines them.

## What an item holds

Both operations give each file as the same JSON object, the row the platform lists:

| Field | What it is |
|---|---|
| `file_id` | The file's ID, which **Download** takes under **Find File By → ID**. |
| `uri` | The file's address in Pipelex storage, `pipelex-storage://…`, which a run takes as an input (see [Giving a team file to a run](#giving-a-team-file-to-a-run)). |
| `name` | The name your team sees in Pipelex, extension included. A member may rename a file in the app, so this is the current name, not necessarily the one it was uploaded under. |
| `media_type` | The file's MIME type, such as `application/pdf`. |
| `format` | The format key Pipelex gives the file, such as `pdf`, `docx` or `image`. |
| `size` | The size in bytes. |
| `kind` | `uploaded`, `generated` (made by a run) or `test` (made by the build assistant). |
| `origin` | Where the file came from: `surface` for an upload, and the `run_id`, `method_id` and `method_version` of the run that made a generated file. |
| `created_at` | When the file was created, an ISO 8601 instant. |
| `created_by` | The user ID of the member who uploaded it, or who started the run that made it. |

A list never holds a file a run made along the way rather than as a final output, nor an upload whose bytes have not reached storage yet.

## Get Many

**Return All** off (the default) returns up to **Limit** files (50 by default); on, it returns every file that matches. The node asks the platform for its largest page and follows the list's cursor until it has enough files or the list ends. A filtered page can come back short, or even empty, while more files match further on, so the node keeps reading until the platform says the list is over, never stopping at the first short page.

Each file is one output item, paired with the input item that asked for it. An empty list returns no item. With several input items, the node lists once per item.

### Filters

Add any of these under **Filters**; a filter you add and leave blank is ignored.

| Filter | Query parameter | What it keeps |
|---|---|---|
| **Search** | `q` | Files whose name or original name contains the text, ignoring case. |
| **Kind** | `kind` | `Uploaded`, `Generated` or `Test`. |
| **Format** | `format` | Files of any of the format keys you give, separated by commas, such as `pdf, image`. |
| **Media Type** | `media_type` | Files of any of the MIME types you give, separated by commas, such as `image/png, image/jpeg`. |
| **Created By** | `created_by` | One member's files, by user ID, or `me` (the default when you add it) for the files of the key's owner: their uploads and the outputs of the runs they started. |
| **Method ID** | `method_id` | The files of one stored method, by its bare ID: the files its runs and examples took or made. |
| **Run ID** | `run_id` | The files of one run, by its `pipeline_run_id`: its final outputs and the files given inline as its inputs. This list comes in the order of the files' addresses rather than newest first. |
| **Created From** | `created_from` | Files created at or after this date and time. |
| **Created To** | `created_to` | Files created at or before this date and time. A date with no time, such as `2026-10-01`, includes that whole day; a time of 00:00 is midnight at the start of the day, which leaves the day itself out. |

A date picked without a time zone, as n8n's date picker gives it, is read in the workflow's time zone (its settings, or the instance's); a date with an offset or a `Z`, such as one an expression builds, is taken as it is. The picker always gives a time, so to take in a whole day with it, set **Created To** to 23:59:59 that day, or to 00:00 the next day. The node sends both bounds as instants, and a range whose start is after its end is refused by the platform.

## Download

**Find File By** says how the node finds the file:

- **Name** (the default): type the file's name in **File Name**, extension included, such as `March invoice.pdf`. The node lists your organization's files with the name as the search, keeps only those whose whole name is the one you gave, compared ignoring case and the way accented letters are encoded (so `march invoice.PDF` finds `March invoice.pdf`, and an `é` typed in n8n finds the `é` a Mac stored as an `e` and an accent, but `Old March invoice.pdf` does not), and downloads the match. A name is found when Pipelex stored its accented letters all in one form or the other, or exactly as you typed them; a name stored with some accents in one form and some in the other is not found by name yet, so download that file by its ID. The comparison is on the file's current `name`, not on the name it was uploaded under before a rename.
- **ID**: put the file's `file_id` in **File ID**, typically mapped from an item of **Get Many** (`{{ $json.file_id }}`). This finds exactly one file, whatever its name.

When no file carries the name, the item fails saying so, once the whole list has been read.

### When several files have the same name

Names are not unique: two members can upload a `report.pdf` each, and uploading a new version of a document under its old name adds a file rather than replacing one. **If Several Files Have This Name** decides what happens then:

- **Use the Newest** (the default) downloads the file created last. The list comes newest first, so the node stops at the first match and reads no further.
- **Fail** fails the item when a second file carries the name, naming two of them by ID and creation date, so you can choose one and download it by its ID. To be sure no second file exists, the node reads the whole list before downloading the one match.

### The binary output

The file lands in the binary field **Put Output File in Field** names (`data` by default), with the MIME type Pipelex recorded, under the name your team sees in Pipelex made safe as a file name. Pipelex keeps a name as it was typed, slashes and `..` included, while a node that writes the file to disk trusts its name to be a bare file name, so in the binary's name each run of `/`, `\` and the other characters a file system refuses (`: * ? " < > |`) becomes a `-`, invisible characters (control and formatting characters, such as a right-to-left override, a zero-width joiner or a soft hyphen) become spaces, and trailing dots and spaces go: a file named `../../notes.pdf` lands as `..-..-notes.pdf`, which cannot lead a Read/Write Files from Disk node out of its folder. The extension is kept, and a name with nothing left becomes `file`. The item's JSON keeps the whole name in `name`, the same row **Get Many** gives, whichever way the file was found. A later node takes the file from that binary field, as it would a Gmail attachment or a Google Drive download.

### How the bytes travel

The node asks the platform for a fresh link to the file (`POST /v1/files/links`), then downloads the bytes from Pipelex storage directly with that link: they do not pass through the Pipelex API. It follows that:

- **The n8n instance must reach Pipelex storage** as well as the API, which matters on a self-hosted n8n behind an egress allowlist. The storage host is the one **Binary Inputs** uploads to.
- **The link is a bearer capability**, valid for fifteen minutes to anyone who holds it, so the node never puts it in an item, an error message or an error's details. It asks for a new link on every download, retries included.

The bytes are streamed: the node hands them to n8n as they arrive from storage instead of first gathering the whole file in memory. Whether n8n then holds them in memory depends on its binary data mode (`N8N_DEFAULT_BINARY_DATA_MODE`). In `filesystem` mode n8n writes them to disk as they arrive, so even a file of hundreds of megabytes never sits whole in the worker's memory. The `default` mode keeps every binary in memory by design, and some n8n versions' `s3` mode collects a file in memory before sending it to the bucket, so for large files on a self-hosted n8n, `filesystem` mode is the one that keeps memory flat.

The download has a deadline of a minute plus a second for every 128 KiB of the file's recorded size, as an upload does, and it stops when the execution is cancelled. The deadline covers the whole transfer, from the request to the last byte stored, and when it passes or the execution is cancelled the node closes the connection to storage, whatever has arrived by then. When storage refuses the download, the node reads only the start of storage's answer, where its error code and message are, to say why, and closes the connection there.

### When a download fails

| The item's error says | What happened, and what to do |
|---|---|
| *…hold no file named "…"* | No file carries that name. Check the spelling and extension, or list the files with **Get Many** and a **Search** filter. |
| *Several of your organization's files are named "…", such as … and …* | **Fail** was chosen and two files carry the name. Download one by its ID, or switch to **Use the Newest**. |
| *…hold no file with ID "…"* | No file of your organization has that ID. |
| *The upload of the file "…" has not finished* | The file's bytes have not reached storage yet. Retry the item in a moment. |
| *…no longer holds the file "…"* | The file was deleted after it was found. |
| *…the download link expired before the download started* | The link outlived its fifteen minutes before storage answered. Retry the item, which asks for a new link. |
| *…could not reach storage at …* | The n8n instance cannot reach Pipelex storage. Allow its host, which the message names. |
| *…did not finish within … s* | The download ran out of time. Retry the item. |
| *…broke off before the whole file arrived* | The connection to storage failed partway through the file. Retry the item. |
| *n8n could not store "…" as binary data…* | Storage sent the file, but n8n's binary data store refused it, for instance because its disk is full. Check where n8n keeps binary data, then retry the item. |
| *The credential's Base URL offers no files routes…* | The Base URL is not the hosted API, or is a backend that does not serve the files routes. |

A refusal by your role starts with *"Your role in this organization does not allow this"*, as for a run (see [When your role in the organization refuses the run](usage.md#when-your-role-in-the-organization-refuses-the-run)). With **Continue On Fail** on, a failed item becomes an item holding the error, as for the run operations.

## Giving a team file to a run

A run takes a file of your organization by its address, so a team file need not be downloaded to reach a Pipelex run. Find it with **Get Many** (a **Search** filter, say), then map its row into the run's **Inputs** in the shape **Binary Inputs** sends:

```json
{
  "document": {
    "url": "{{ $json.uri }}",
    "filename": "{{ $json.name }}",
    "mime_type": "{{ $json.media_type }}"
  }
}
```

Use **Download** when the bytes have to go somewhere else: a mail attachment, a Google Drive folder, or another service's API.
