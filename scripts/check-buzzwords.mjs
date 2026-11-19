import fs from "fs";

const words = ["safe", "secure", "seamless", "powerful", "robust", "blazing"];

function checkFile(path) {
  if (!fs.existsSync(path)) return;
  const content = fs.readFileSync(path, "utf8");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const w of words) {
      const re = new RegExp(`\\b${w}\\w*`, "gi");
      const matches = line.match(re);
      if (matches) {
        console.log(`${path}:${i + 1}: [${matches.join(", ")}] -> ${line.trim()}`);
      }
    }
  }
}

function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = `${dir}/${f}`;
    if (fs.statSync(p).isDirectory()) {
      if (f !== "node_modules" && f !== "dist" && f !== ".git") walk(p);
    } else if (f.endsWith(".tsx") || f.endsWith(".ts") || f.endsWith(".md") || f.endsWith(".html")) {
      checkFile(p);
    }
  }
}

console.log("=== CHECKING README.md ===");
checkFile("README.md");

console.log("\n=== CHECKING packages/ui/src ===");
walk("packages/ui/src");
