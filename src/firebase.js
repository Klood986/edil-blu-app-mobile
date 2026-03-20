import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyDLXruxNaNZibqdN5KzVZikOrwJuOfPY5w",
  authDomain: "edil-blu-app.firebaseapp.com",
  projectId: "edil-blu-app",
  storageBucket: "edil-blu-app.firebasestorage.app",
  messagingSenderId: "766843375405",
  appId: "1:766843375405:web:92f9a77236c3dc6afd0da4"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
