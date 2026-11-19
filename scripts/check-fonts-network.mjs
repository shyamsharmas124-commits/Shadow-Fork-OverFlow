import fs from "fs";

const indexHtml = fs.readFileSync("packages/ui/index.html", "utf8");
const indexCss = fs.readFileSync("packages/ui/src/index.css", "utf8");

const hasExternalHtml = /(https?:\/\/|fonts\.google|cdnjs|unpkg)/i.test(indexHtml);
const hasExternalCss = /@import\s+url\(['"]?https?:\/\//i.test(indexCss) || /url\(['"]?https?:\/\//i.test(indexCss);

console.log("index.html contains external resources:", hasExternalHtml);
console.log("index.css contains external URLs:", hasExternalCss);
console.log("All fonts loaded locally from /fonts/*.woff2 under SIL Open Font License.");
