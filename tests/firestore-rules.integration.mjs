import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import { initializeApp as initializeAdminApp, deleteApp as deleteAdminApp } from 'firebase-admin/app';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import {
  getFirestore, connectFirestoreEmulator, doc, collection, getDoc, getDocs,
  setDoc, updateDoc, deleteDoc, terminate,
} from 'firebase/firestore';

// Fail before initializing any SDK if this command is pointed at a real service.
const projectId = 'demo-easysplit-audit';
const emulator = process.env.FIRESTORE_EMULATOR_HOST || '';
assert.match(emulator, /^127\.0\.0\.1:\d+$/, 'A loopback Firestore emulator is required');
const [host, portText] = emulator.split(':');
const port = Number(portText);
assert.ok(port > 0 && port < 65536);

const adminApp = initializeAdminApp({ projectId }, 'audit-rules-admin');
const adminDb = getAdminFirestore(adminApp);
const apps = [];
const clients = [];
function client(uid) {
  const app = initializeApp({ projectId, apiKey: 'emulator-only' }, `audit-rules-${uid || 'guest'}`);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, host, port, uid ? { mockUserToken: { sub: uid } } : {});
  apps.push(app);
  clients.push(db);
  return db;
}
const alice = client('audit-alice');
const bob = client('audit-bob');
const guest = client();
const newOwner = client('audit-new');
const privateCollections = [
  'sessions', 'groups', 'history', 'restaurants', 'restaurant_visits',
  'restaurant_observations', 'restaurant_visit_source_deletions',
  '_room_codes', 'receipt_proof_uses', 'rate_limits', 'unknown_collection',
];

test.before(async () => {
  const batch = adminDb.batch();
  for (const path of ['users/audit-alice', 'users/audit-bob', 'users/audit-alice/history/audit-record',
    ...privateCollections.map(name => `${name}/audit-record`)]) {
    batch.set(adminDb.doc(path), { fixture: true, owner: 'audit-alice' });
  }
  await batch.commit();
});
test.after(async () => {
  await Promise.all(clients.map(db => terminate(db)));
  await Promise.all(apps.map(app => deleteApp(app)));
  await adminDb.terminate();
  await deleteAdminApp(adminApp);
});

const denied = operation => assert.rejects(operation, error => error.code === 'permission-denied');

test('an owner can read their profile but nobody can enumerate profiles', async () => {
  assert.equal((await getDoc(doc(alice, 'users/audit-alice'))).data().fixture, true);
  for (const db of [alice, bob, guest]) await denied(getDocs(collection(db, 'users')));
});

test('another user and an unauthenticated client cannot read a profile', async () => {
  for (const db of [bob, guest]) await denied(getDoc(doc(db, 'users/audit-alice')));
});

test('profile creation, updates and deletion require the backend, including for the owner', async () => {
  await denied(setDoc(doc(newOwner, 'users/audit-new'), { fixture: true }));
  for (const db of [alice, bob, guest]) {
    await denied(setDoc(doc(db, 'users/audit-new'), { fixture: true }));
    await denied(updateDoc(doc(db, 'users/audit-alice'), { admin: true }));
    await denied(deleteDoc(doc(db, 'users/audit-alice')));
  }
});

test('own-profile access does not grant access to nested history', async () => {
  await denied(getDoc(doc(alice, 'users/audit-alice/history/audit-record')));
  await denied(setDoc(doc(alice, 'users/audit-alice/history/audit-new'), { fixture: true }));
});

for (const name of privateCollections) {
  test(`${name} rejects direct reads, lists and writes from every client identity`, async () => {
    for (const db of [alice, bob, guest]) {
      await denied(getDoc(doc(db, `${name}/audit-record`)));
      await denied(getDocs(collection(db, name)));
      await denied(setDoc(doc(db, `${name}/audit-new`), { fixture: true }));
      await denied(updateDoc(doc(db, `${name}/audit-record`), { owner: 'attacker' }));
      await denied(deleteDoc(doc(db, `${name}/audit-record`)));
    }
  });
}
