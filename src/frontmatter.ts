export interface ParsedFrontmatter {
    [key: string]: string | string[] | number | undefined;
}

export function extractFrontmatter(content: string): ParsedFrontmatter {
    const frontmatter: ParsedFrontmatter = {};
    // Regex to find frontmatter block (--- block ---)
    const frontmatterMatch = content.match(
        /^---\s*[\r\n]([\s\S]*?)[\r\n]---\s*[\r\n]?/,
    );

    if (!frontmatterMatch || !frontmatterMatch[1]) {
        return frontmatter;
    }

    const yamlLines = frontmatterMatch[1].split(/[\r\n]+/);

    for (const line of yamlLines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith("#")) continue;

        const colonIndex = trimmedLine.indexOf(":");
        if (colonIndex === -1) {
            continue;
        }

        const key = trimmedLine.substring(0, colonIndex).trim();
        let valueString = trimmedLine.substring(colonIndex + 1).trim();

        let parsedValue: any;

        // Handle explicit quotes for strings
        if (
            (valueString.startsWith('"') && valueString.endsWith('"')) ||
            (valueString.startsWith("'") && valueString.endsWith("'"))
        ) {
            parsedValue = valueString.slice(1, -1)
                .replace(/\\"/g, '"').replace(/\\'/g, "'"); // Handle escaped quotes within
        } // Handle lists (simple comma-separated or YAML flow sequence)
        else if (valueString.startsWith("[") && valueString.endsWith("]")) {
            try {
                // Attempt to parse as JSON array, then clean up strings
                const items = JSON.parse(valueString.replace(/'/g, '"')); // Replace single with double for JSON
                if (Array.isArray(items)) {
                    parsedValue = items.map((item) =>
                        typeof item === "string" ? item.trim() : item
                    );
                } else {
                    parsedValue = valueString; // Fallback to raw string
                }
            } catch (e) {
                // Fallback for simple comma-separated lists if JSON parse fails
                parsedValue = valueString.slice(1, -1).split(",")
                    .map((v) => v.trim().replace(/^['"]|['"]$/g, "")); // Trim and remove outer quotes from items
            }
        } // Handle booleans
        else if (valueString.toLowerCase() === "true") {
            parsedValue = true;
        } else if (valueString.toLowerCase() === "false") {
            parsedValue = false;
        } // Handle null
        else if (
            valueString.toLowerCase() === "null" || valueString === "~" ||
            valueString === ""
        ) {
            // Treat empty string value as null for frontmatter
            parsedValue = null;
        } // Handle numbers
        else if (
            !Number.isNaN(Number(valueString)) && valueString.trim() !== ""
        ) {
            // Check if it looks like a date string "YYYY-MM-DD" before parsing as number
            if (!/^\d{4}-\d{2}-\d{2}/.test(valueString)) {
                parsedValue = Number(valueString);
            } else {
                parsedValue = valueString; // Keep as string if it looks like a date
            }
        } // Default to string
        else {
            parsedValue = valueString;
        }
        frontmatter[key] = parsedValue;
    }
    return frontmatter;
}

export interface FrontmatterContent {
    content: string;
    frontmatter: ParsedFrontmatter;
}

export function parseFrontmatterAndContent(
    content: string,
): FrontmatterContent {
    // Regex to match frontmatter block and the content after it
    // Allows for optional newlines after the closing '---'
    const frontmatterMatch = content.match(
        /^---\s*[\r\n]([\s\S]*?)[\r\n]---\s*([\r\n]{0,2})([\s\S]*)$/,
    );

    if (!frontmatterMatch) {
        // No frontmatter found, or format is incorrect
        return { content, frontmatter: {} };
    }

    // frontmatterMatch[1] is the YAML block
    // frontmatterMatch[3] is the content after the frontmatter and optional newlines
    const yamlBlock = frontmatterMatch[1];
    const bodyContent = frontmatterMatch[3] || ""; // Ensure bodyContent is a string

    const frontmatter = extractFrontmatter(`---\n${yamlBlock}\n---`); // Re-add markers for extractFrontmatter

    return { content: bodyContent, frontmatter };
}
