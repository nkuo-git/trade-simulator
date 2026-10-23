// 家庭雲端同步（Firebase Firestore）
// families/{代碼}            家庭設定：家長密碼、起始資金、家長對每個玩家的控制（解鎖、重設、改名、移除）
// families/{代碼}/profiles/{玩家}  每個玩家的完整進度（JSON 字串）
import { FIREBASE_CONFIG } from './firebase-config.js';

const V = '10.12.2';
let db = null, fs = null;

export const syncAvailable = () => !!FIREBASE_CONFIG;

async function init() {
  if (db) return;
  const app = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
  fs = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);
  db = fs.getFirestore(app.initializeApp(FIREBASE_CONFIG));
}

export async function getFamily(fid) {
  await init();
  const s = await fs.getDoc(fs.doc(db, 'families', fid));
  return s.exists() ? s.data() : null;
}
export async function setFamily(fid, patch) {
  await init();
  await fs.setDoc(fs.doc(db, 'families', fid), patch, { merge: true });
}
export async function listProfiles(fid) {
  await init();
  const s = await fs.getDocs(fs.collection(db, 'families', fid, 'profiles'));
  return s.docs.map((d) => JSON.parse(d.data().data));
}
export async function pushProfile(fid, p) {
  await init();
  await fs.setDoc(fs.doc(db, 'families', fid, 'profiles', p.id), { data: JSON.stringify(p), name: p.name, updated: Date.now() });
}
export async function removeProfile(fid, pid) {
  await init();
  await fs.deleteDoc(fs.doc(db, 'families', fid, 'profiles', pid));
}
// 回傳取消監聽的函式
export async function watchFamily(fid, cb) {
  await init();
  return fs.onSnapshot(fs.doc(db, 'families', fid), (s) => cb(s.exists() ? s.data() : null), () => {});
}
export async function watchProfiles(fid, cb) {
  await init();
  return fs.onSnapshot(fs.collection(db, 'families', fid, 'profiles'), (s) => cb(s.docs.map((d) => JSON.parse(d.data().data))), () => {});
}
