import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--vencord") {
    console.error("Usage: node scripts/install-plugin.mjs --vencord /path/to/Vencord");
    process.exit(1);
}
const vencord = resolve(args[1]);
const manifest = JSON.parse(await readFile(join(vencord, "package.json"), "utf8"));
if (manifest.name !== "vencord") throw new Error("Choose the Vencord source checkout, not the installed Discord folder.");
const destination = join(vencord, "src", "userplugins", "discordChatExporter.desktop");
const marker = ".discord-chat-exporter-owned";
const existing = await lstat(destination).catch(error => {
    if (error.code !== "ENOENT") throw error;
});
if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error("Plugin destination must be a regular directory.");
    const files = await readdir(destination);
    if (files.length && !files.includes(marker)) throw new Error("Existing plugin was not installed by this script; preserve it or move it before installing.");
}
await mkdir(destination, { recursive: true });
await cp(join(project, "plugin"), destination, { recursive: true, force: true });
await writeFile(join(destination, marker), "Installed from vencord-discord-chat-exporter\n");
console.log(`Plugin copied to ${destination}\nNext: build your Vencord checkout, then install that custom build and enable DiscordChatExporter.`);
