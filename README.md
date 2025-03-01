# KoReader Highlights Importer Plugin for Obsidian

This plugin imports **highlights and notes** from [KoReader](https://github.com/koreader/koreader) into [Obsidian](https://obsidian.md/) notes. It scans for `.sdr` directories, parses Lua metadata files, and saves both highlights and associated notes into Markdown files within Obsidian.


## ✨ Features
- **Import Highlights and notes**: Import highlights and any associated notes from your KoReader into Obsidian.
- **Scan Highlights**: Scan for metadata files on your KoReader device.
- **Customizable Settings**: Configure the mount point, excluded folders, allowed file types, and highlights folder.
- **Automatic Metadata Handling:** Extracts metadata like author, title, description, pages, and keywords from KoReader's metadata files and adds it as YAML frontmatter to your Obsidian notes.

## 📦 Installation

You can install the KoReader Highlights Importer Plugin using one of the following methods:

### Option 1: Install from Obsidian's Community Plugins (Recommended)
This is the easiest way to install the plugin, as it uses Obsidian’s built-in marketplace:

1- Open **Obsidian** and navigate to **Settings > Community plugins**.  
2- In the **Community plugins** section, click **Browse**.  
3- Type "**KoReader Highlights Importer**" into the search bar.  
4- Click on the plugin from the search results, then click **Install**.  
5- After installation, return to **Settings > Community plugins**, locate "**KoReader Highlights Importer**" in the list, and toggle the switch to enable it.

### Option 2: Manual Installation

   1- Download or clone this repository into your Obsidian vault's plugins (`<vault-directory>/.obsidian/plugins`)  
      *(Tip: To find your plugins folder: Go to **Settings > Community Plugins > Installed plugins**, and click the 📂 icon next to the "Installed plugins" heading.)*  
   2- Close and reopen Obsidian.  
   3- **Enable:** Go to **Settings > Community plugins**, find "KoReader Highlights Importer," and toggle the switch to enable it.

## ⚙️ Setup & Configuration

After enabling the plugin, configure it in the settings tab:

1. Navigate to **Settings > Community plugins** and click on "KoReader Highlights Importer" to access its settings.

2. **Core Settings:**
   - **KoReader Mount Point**: Set the directory where your KoReader device is mounted (or the root folder of the books you want to import).
   - **Highlights Folder**:  Specify the folder within your Obsidian vault where you want your imported highlight notes to be saved (e.g., `Reading/KoReader Highlights`). This folder will be created if it doesn't exist.

3. **Filtering & Exclusion:**
   - **Excluded Folders**: Provide a comma-separated list of folder names on your KoReader device that you want the plugin to ignore during the scanning process (e.g., `.adds,.kobo`).
   - **Allowed File Types**: Specify file types to look for in metadata (default: `epub`, `mobi`, `html`). Leave this field empty if you want to process all supported file types.

2. **Commands**:
   - `Import KoReader Highlights`: Imports highlights from your device.
   - `Scan KoReader Highlights`: Scans for highlight files without importing.

## 🚀 Usage

Here's how to use the KoReader Highlights Importer:
1. **Connect your KoReader device to your computer and ensure it's mounted.** You should see it as a removable drive or volume.
2. **Open your Obsidian vault.**
3. **Trigger the Import Process:** You can import highlights in two ways:
   * **Using the Command Palette:** Press `Ctrl/Cmd + P`, type "Import KoReader Highlights", and select the command.
   * **Using the button in the plugin settings:** Click the "Import KoReader Highlights" button in the plugin settings.
4. **(Optional) Scan for Highlights First:** If you want to see which files will be processed before importing, you can use the "Scan KoReader Highlights" command. This will generate a list of found `.sdr` directories in a note named "KoReader SDR Files.md".


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
