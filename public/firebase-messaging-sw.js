/* eslint-disable no-restricted-globals */
importScripts('https://www.gstatic.com/firebasejs/10.0.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.0.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDLXruxNaNZibqdN5KzVZikOrwJuOfPY5w",
  authDomain: "edil-blu-app.firebaseapp.com",
  projectId: "edil-blu-app",
  storageBucket: "edil-blu-app.firebasestorage.app",
  messagingSenderId: "766843375405",
  appId: "1:766843375405:web:92f9a77236c3dc6afd0da4"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || 'Edil Blu';
  const body = payload.notification?.body || '';

  self.registration.showNotification(title, {
    body,
    icon: '/logo192.png',
    badge: '/logo192.png',
    vibrate: [200, 100, 200],
    tag: payload.data?.tipo || 'default',
  });
});
