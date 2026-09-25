// 迁移脚本：初始化/升级数据库结构（幂等）
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../server/db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const dbFile = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(dataDir, 'chat.db');

store.initDb({ file: dbFile, schemaFile: path.join(ROOT, 'db', 'schema.sql') });
const counts = store.tableCounts();
console.log('迁移完成:', dbFile);
console.log('表行数:', JSON.stringify(counts));
store.closeDb();
