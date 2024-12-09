# Obsidian KoReader Highlights Importer Plugin

This plugin imports highlights from [KoReader](https://github.com/koreader/koreader) into [Obsidian](https://obsidian.md/) notes. It scans for `.sdr` directories, parses Lua metadata files, and saves highlights into Markdown files within Obsidian.

## Features
- **Import Highlights**: Import highlights from your KoReader into Obsidian.
- **Scan Highlights**: Scan for highlight files on your KoReader device.
- **Customizable Settings**: Configure the mount point, excluded folders, allowed file types, and highlights folder.
- **Automatic Metadata Handling:** Extracts metadata like author, title, description, pages, and keywords from KoReader's metadata files and adds it as YAML frontmatter to your Obsidian notes.

## Installation
   - Download or clone this repository into your Obsidian vault's plugins. The location of this folder varies by operating system:
       * **Windows:** `%APPDATA%\Obsidian\plugins`
       * **macOS:** `~/Library/Application Support/Obsidian/plugins`
       * **Linux:** `~/.config/obsidian/plugins`
       * or `<vault-directory>/.obsidian/plugins`

      (You can also find your plugins folder by going to Settings > Community Plugins > And Click the 📂 icon beside the installed plugins section.)
   - Close and reopen Obsidian.
   - **Enable:** Go to **Settings > Community plugins**, find "KoReader Highlights Importer," and toggle the switch to enable it.


## Setup
1. **Plugin Settings**:
   - **KoReader Mount Point**: Set the directory where your KoReader device is mounted (or the root folder of the books you want to import).
   - **Highlights Folder**: Choose where in your vault you want highlights to be saved.
   - **Excluded Folders**: List folders to ignore during the scan.
   - **Allowed File Types**: Specify file types to look for in metadata (default: `epub`, `mobi`, `html`). Leave this field empty if you want to process all supported file types.

2. **Commands**:
   - `Import KoReader Highlights`: Imports highlights from your device.
   - `Scan KoReader Highlights`: Scans for highlight files without importing.

## Usage
1. Connect your KoReader device to your computer and mount it.
2. Open the Obsidian settings and navigate to the KoReader Highlight Importer plugin settings.
3. Click the "Import Highlights" button to import the highlights into your Obsidian vault.


**Settings**

The plugin has the following settings:

* **KoReader Mount Point**: Specify the directory where your KoReader device is mounted (e.g., `/media/user/KOBOeReader`).
* **Highlights Folder**: Specify the directory where you would like to save your highlights (e.g., `KoReader Highlights`).
* **Excluded Folders**: Comma-separated list of folders to exclude from the import process (e.g., `folder1,folder2`).
* **Allowed File Types**: Comma-separated list of file types to include in the import process (e.g., `epub,pdf`).

**Troubleshooting**

*   **Error Messages:** If you encounter issues, open the Obsidian Developer Console (`Ctrl/Cmd + Shift + I` on Windows/Linux, `Cmd + Option + I` on macOS) and check for error messages related to the plugin.
*   **Mount Point:** Double-check that you've entered the correct mount point for your KoReader device in the plugin settings.
*   **Permissions:** Ensure that Obsidian has the necessary permissions to access the mounted KoReader device and your specified highlights folder.

## Development
- **Install Dependencies**: `npm install`
- **Building**: Use `npm run build` to compile the plugin.
- **Testing**: The plugin uses Obsidian's API for file operations and plugin lifecycle management.

## Contributing
Contributions are welcome! Please fork the repository, make your changes, and submit a pull request.

## License
This project is licensed under the MIT License.
