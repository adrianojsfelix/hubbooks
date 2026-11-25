// Armazenamento local (IndexedDB): metadados dos livros + arquivos PDF.
const DB_NAME = 'hubbooks';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const db = {
  allBooks: () => run('books', 'readonly', s => s.getAll()),
  putBook: book => run('books', 'readwrite', s => s.put(book)),
  deleteBook: id => run('books', 'readwrite', s => s.delete(id)),
  // Guardamos ArrayBuffer (mais compatível com Safari/iOS do que Blob).
  putFile: (id, data) => run('files', 'readwrite', s => s.put({ id, data })),
  getFile: async id => (await run('files', 'readonly', s => s.get(id)))?.data,
  deleteFile: id => run('files', 'readwrite', s => s.delete(id)),
  fileIds: () => run('files', 'readonly', s => s.getAllKeys()),
};
