const text = process.argv.slice(2).join(' ');
const lines = text ? text.split(/\r?\n/).length : 0;
const words = text.trim() ? text.trim().split(/\s+/).length : 0;
const chars = [...text].length;
console.log(JSON.stringify({ lines, words, chars }, null, 2));
