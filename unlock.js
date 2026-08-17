import crypto from "crypto";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();


// ==============================
// 暗号化データの読み込み
// ==============================

const key = Buffer.from(process.env.STUDENT_KEY, "hex");
const iv = fs.readFileSync("students.iv");
const tag = fs.readFileSync("students.tag");
const encrypted = fs.readFileSync("students.enc");


// ==============================
// AES-256-GCM で復号
// ==============================

const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    iv
);

decipher.setAuthTag(tag);

const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
]);


// ==============================
// JSONとして読み込み
// ==============================

const students = JSON.parse(decrypted.toString("utf8"));


// ==============================
// 復号結果
// ==============================

console.log("復号結果：");
console.log(students);


// ==============================
// 学籍番号 → 名前
// ==============================

export function getName(studentNumber) {
    return students[studentNumber] || "不明";
}


// ==============================
// 名前 → 学籍番号
// ==============================

export function getStudentNumber(name) {
    for (const [studentNumber, studentName] of Object.entries(students)) {
        if (studentName === name) {
            return studentNumber;
        }
    }

    return "不明";
}