/* global firebase */

const Votes = (() => {
    const LS_KEY = "stationVotes";
    let db = null;

    function sanitizeCode(code) {
        return (code || "").replace(/\//g, "_");
    }

    function getLocalVotes() {
        try {
            return JSON.parse(localStorage.getItem(LS_KEY)) || {};
        } catch { return {}; }
    }

    function setLocalVote(stationId, type) {
        const votes = getLocalVotes();
        if (type) votes[stationId] = type;
        else delete votes[stationId];
        localStorage.setItem(LS_KEY, JSON.stringify(votes));
    }

    function getLocalVote(code) {
        return getLocalVotes()[sanitizeCode(code)] || null;
    }

    function initVotes(firebaseConfig) {
        if (!firebaseConfig || !firebaseConfig.apiKey) {
            console.warn("Votes: Firebase config missing — voting disabled");
            return false;
        }
        try {
            if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
            db = firebase.firestore();
            return true;
        } catch (err) {
            console.error("Votes: Firebase init failed", err);
            return false;
        }
    }

    function docRef(code) {
        return db.collection("votes").doc(sanitizeCode(code));
    }

    async function getVoteCounts(code) {
        if (!db) return { up: 0, down: 0 };
        try {
            const snap = await docRef(code).get();
            if (snap.exists) {
                const d = snap.data();
                return { up: d.up || 0, down: d.down || 0 };
            }
            return { up: 0, down: 0 };
        } catch (err) {
            console.error("Votes: read failed", err);
            return { up: 0, down: 0 };
        }
    }

    async function castVote(code, type) {
        if (!db) return null;
        const id = sanitizeCode(code);
        const prev = getLocalVote(code);
        const inc = firebase.firestore.FieldValue.increment;

        const updates = {};

        if (prev === type) {
            // Toggle off — undo current vote
            updates[type] = inc(-1);
            setLocalVote(id, null);
        } else {
            // New vote or switch
            updates[type] = inc(1);
            if (prev) updates[prev] = inc(-1);
            setLocalVote(id, type);
        }

        try {
            await docRef(code).set(updates, { merge: true });
        } catch (err) {
            console.error("Votes: write failed", err);
        }

        return getLocalVote(code);
    }

    return { initVotes, getVoteCounts, castVote, getLocalVote, sanitizeCode };
})();
