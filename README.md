# KoReader Highlights Importer Plugin for Obsidian

This plugin imports **highlights and notes** from [KoReader](https://github.com/koreader/koreader) into [Obsidian](https://obsidian.md/) notes. It scans for `.sdr` directories, parses Lua metadata files, and saves both highlights and associated notes into Markdown files within Obsidian.


## ✨ Features
### Core Functionality
- **Complete Highlight Import**: Bring over all highlights and associated notes from KoReader
- **Duplicate Handling**: Intelligent detection and management of duplicate highlights

### Customization
- **Flexible Configuration**: Set mount points, excluded folders, and allowed file types
- **Frontmatter Control**: Choose which metadata fields to include (title, author, pages, etc.)
- **Template System**: Customize how highlights are rendered with templating

### Metadata & Organization
- **Automatic Metadata Extraction**: Captures author, title, description, pages, and keywords
- **Reading Statistics**: Optional integration with KoReader's statistics database
- **Structured Output**: Highlights organized by chapter and page number

## 📦 Installation

### Recommended: Via Obsidian Community Plugins
1. Open Obsidian and go to **Settings → Community plugins**
2. Click **Browse** and search for "KoReader Highlights Importer"
3. Click **Install**, then enable the plugin

### Manual Installation
1. Download the latest release from GitHub
2. Extract into your vault's plugins folder:  
   `[vault]/.obsidian/plugins/koreader-highlights-importer`
3. Restart Obsidian and enable the plugin in Settings

> 💡 **Tip**: Find your plugins folder by clicking the 📂 icon next to "Installed plugins" in Community plugins settings.

## ⚙️ Configuration

Access settings via **Settings → Community plugins → KoReader Highlights Importer**

### Essential Settings
- **KoReader Mount Point**: Path where your device is mounted (e.g., `/Volumes/KOBOeReader`)
- **Highlights Folder**: Destination for imported notes (e.g., `Reading/Highlights`)
- **Excluded Folders**: Comma-separated list (e.g., `.adds,.kobo`)
- **Allowed File Types**: Restrict to specific formats (e.g., `epub,pdf`)

### Advanced Options
- **Frontmatter Fields**: Select which metadata fields to include
- **Duplicate Checking**: Choose between folder-only or full vault checking
- **Debug Level**: Adjust logging verbosity for troubleshooting

## 🚀 Usage

Here's how to use the KoReader Highlights Importer:
1. **Connect your KoReader device to your computer and ensure it's mounted.** You should see it as a removable drive or volume.
2. **Open your Obsidian vault.**
3. **Trigger the Import Process:** You can import highlights in two ways:
   * **Using the Command Palette:** Press `Ctrl/Cmd + P`, type "Import KoReader Highlights", and select the command.
   * **Using the button in the plugin settings:** Click the "Import KoReader Highlights" button in the plugin settings.
4. **(Optional) Scan for Highlights First:** If you want to see which files will be processed before importing, you can use the "Scan KoReader Highlights" command. This will generate a list of found `.sdr` directories in a note named "KoReader SDR Files.md".

###  🎨 Templating System
- **Default Templates**: Two built-in templates are provided:
  - `minimal`: A simple structure with chapter titles and highlights.
  - `default`: A structured format with page numbers, dates, and notes.
- **Vault or External Templates**: Choose templates stored in your Obsidian vault or select a file from your computer. You can copy/edit the default templates
- **Conditional Logic**: Support for conditional sections (e.g., `{{#note}}> [!NOTE] {{note}}\n{{/note}}`) to conditionally include notes.
- **Replace {{variables}}**  with your desired fields (e.g., chapter, pageno, highlight, note).


**Troubleshooting**

* **Error Messages:** If you encounter issues, open the Obsidian Developer Console (`Ctrl/Cmd + Shift + I` on Windows/Linux, `Cmd + Option + I` on macOS) and check for error messages related to the plugin.
* **Mount Point:** Double-check that you've entered the correct mount point for your KoReader device in the plugin settings.
* **Permissions:** Ensure that Obsidian has the necessary permissions to access the mounted KoReader device and your specified highlights folder.

## Development
- **Install Dependencies**: `npm install`
- **Building**: Use `npm run build` to compile the plugin.
- **Testing**: The plugin uses Obsidian's API for file operations and plugin lifecycle management.

## Contributing
Contributions are welcome! Please fork the repository, make your changes, and submit a pull request.

## License
This project is licensed under the MIT License.
