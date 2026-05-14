# htmldrop

Publish HTML files and get shareable links. Uses [Surge.sh](https://surge.sh) under the hood.

## Install

```bash
npm install -g htmldrop
```

You'll also need Surge installed globally (or it will use `npx surge` automatically):

```bash
npm install -g surge
```

## Usage

### First-time setup

```bash
htmldrop init
```

This will:
1. Run `surge login` so you can authenticate
2. Ask you to pick a subdomain (e.g., `my-docs`)
3. Save config to `~/.htmldrop/config.json`

### Publish a file

```bash
htmldrop push report.html
```

Returns a URL like `https://my-docs.surge.sh/report.html`

### Publish with password protection

```bash
htmldrop push --password mysecret private-spec.html
```

The file is encrypted client-side with AES-256. Viewers must enter the password to decrypt and view the content.

### Auto-open in browser after publish

```bash
htmldrop push --open report.html
```

### List published files

```bash
htmldrop list
```

### Open a file in browser

```bash
htmldrop open report.html
```

## How it works

- Files are staged in `~/.htmldrop/site/`
- An `index.html` gallery page is auto-generated listing all files
- The entire site directory is deployed to Surge on each push
- Password-protected files use AES encryption via crypto-js (StatiCrypt pattern)

## Config

Stored at `~/.htmldrop/config.json`:

```json
{
  "subdomain": "my-docs",
  "email": "you@example.com"
}
```

## License

MIT
