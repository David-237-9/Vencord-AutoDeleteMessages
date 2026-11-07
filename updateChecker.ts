import { showNotification } from "@api/Notifications";
import { Logger } from "@utils/Logger";

/** EDIT **/
const CURRENT_VERSION = "1.1.0";
const GITHUB_AUTHOR = "David-237-9";
const GITHUB_REPO = "Vencord-AutoDeleteMessages";
/** **** **/

const GITHUB_API = `https://api.github.com/repos/${GITHUB_AUTHOR}/${GITHUB_REPO}/tags?per_page=1`;

function isNewerVersion(latest: string, current: string) {
    const a = latest.split(".").map(Number);
    const b = current.split(".").map(Number);

    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const numA = a[i] ?? 0;
        const numB = b[i] ?? 0;

        if (numA > numB) return true;
        if (numA < numB) return false;
    }

    return false;
}

export async function checkForUpdates(spacedPluginName: string) {
    const logger = new Logger(spacedPluginName.replaceAll(" ", "").toLowerCase());

    try {
        const response = await fetch(GITHUB_API, {
            headers: {
                Accept: "application/vnd.github+json"
            }
        });

        if (!response.ok) {
            throw new Error(`GitHub API: ${response.status}`);
        }

        const data = await response.json();
        const tag = data[0];

        if (!tag?.name) {
            logger.warn("No GitHub tags found.");
            return;
        }

        const latestVersion = tag.name
            .replace(/^v/i, "") // Remove leading 'v' (not case-sensitive)
            .replaceAll("_", "."); // replace underscores with dots

        if (isNewerVersion(latestVersion, CURRENT_VERSION)) {
            logger.warn(`New version available: ${latestVersion}`);

            await showNotification({
                title: `${spacedPluginName} ${CURRENT_VERSION} -> ${latestVersion}`,
                body: `Please update the plugin from GitHub at github.com/${GITHUB_AUTHOR}/${GITHUB_REPO}`,
            });
        } else {
            // logger.info("Plugin is up to date.");
        }
    } catch (error) {
        logger.error("Error checking for updates:", error);
    }
}
