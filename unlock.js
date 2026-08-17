import crypto from "crypto";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

const key = Buffer.from(process.env.STUDENT_KEY, "hex");
const iv = fs.readFileSync("students.iv");
const tag = fs.readFileSync("students.tag");
const encrypted = fs.readFileSync("students.enc");

const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
decipher.setAuthTag(tag);

const students = JSON.parse(
  Buffer.concat([decipher.update(encrypted), decipher.final()])
);

console.log("復号結果：");
console.log(students);

// 1人だけ取り出したい場合の関数
export function getName(code) {
  return students[code] || "不明";
}