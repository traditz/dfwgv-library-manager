/* global __firebase_config, __app_id, __initial_auth_token */
import React, { useState, useEffect, createContext, useContext, useRef, useCallback, memo, useMemo } from 'react'; // Added useMemo
import { initializeApp } from 'firebase/app';
import * as FirebaseAuth from 'firebase/auth'; // Import all from firebase/auth as FirebaseAuth
import { getFirestore, doc, getDoc, addDoc, setDoc, updateDoc, deleteDoc, deleteField, onSnapshot, collection, getDocs } from 'firebase/firestore';

// Define Firebase configuration explicitly for external deployment (e.g., GitHub Pages).
// When running within the Canvas environment, global variables __firebase_config and __initial_auth_token
// are typically provided and take precedence for authentication.
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {
    apiKey: "AIzaSyDkJPKUki0-SD2cWiiMJ-JCHhXcZzo-eKc", // YOUR ACTUAL API KEY
    authDomain: "dfwgv-library-manager.firebaseapp.com", // YOUR ACTUAL AUTH DOMAIN
    projectId: "dfwgv-library-manager", // YOUR ACTUAL PROJECT ID
    storageBucket: "dfwgv-library-manager.firebasestorage.app", // YOUR ACTUAL STORAGE BUCKET
    messagingSenderId: "465824512280", // YOUR ACTUAL MESSAGING SENDER ID
    appId: "1:465824512280:web:6684fb67e92c65f6fb466d" // YOUR ACTUAL APP ID
};

// Use __app_id if available, otherwise fallback to firebaseConfig.projectId
const appId = typeof __app_id !== 'undefined' ? __app_id : firebaseConfig.projectId;

// Overall admins (lowercase emails). Only these logins see the Planner-sync controls.
const ADMIN_EMAILS = ['joemsprague@gmail.com'];

// DFWGV Planner lives in its own Firebase project. Its public+published gamedays and
// their tables are world-readable, so the sync reads them over the Firestore REST API
// rather than initializing a second Firebase app.
const PLANNER_PROJECT_ID = 'dfwgv-planner';
const PLANNER_BASE_URL = `https://firestore.googleapis.com/v1/projects/${PLANNER_PROJECT_ID}/databases/(default)/documents`;

// Collapse a Firestore REST typed value ({stringValue: "x"}) into a plain JS value.
const parseFsValue = (value) => {
    if (value === null || value === undefined) return null;
    if ('stringValue' in value) return value.stringValue;
    if ('integerValue' in value) return parseInt(value.integerValue, 10);
    if ('doubleValue' in value) return value.doubleValue;
    if ('booleanValue' in value) return value.booleanValue;
    if ('timestampValue' in value) return value.timestampValue;
    if ('mapValue' in value) return parseFsFields(value.mapValue.fields || {});
    if ('arrayValue' in value) return (value.arrayValue.values || []).map(parseFsValue);
    return null;
};

const parseFsFields = (fields) => {
    const out = {};
    for (const [key, value] of Object.entries(fields)) {
        out[key] = parseFsValue(value);
    }
    return out;
};

const parseFsDoc = (docJson) => ({ id: docJson.name.split('/').pop(), ...parseFsFields(docJson.fields || {}) });

// Public, published Planner events, newest first. The visibility/status filters are
// required — the Planner's rules only permit anonymous reads of that query shape.
async function fetchPlannerGamedays() {
    const response = await retryFetch(`${PLANNER_BASE_URL}:runQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            structuredQuery: {
                from: [{ collectionId: 'gamedays' }],
                where: {
                    compositeFilter: {
                        op: 'AND',
                        filters: [
                            { fieldFilter: { field: { fieldPath: 'visibility' }, op: 'EQUAL', value: { stringValue: 'public' } } },
                            { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'published' } } },
                        ],
                    },
                },
                limit: 100,
            },
        }),
    });
    if (!response.ok) throw new Error(`Planner returned HTTP ${response.status}`);
    const rows = await response.json();
    return rows
        .filter(row => row.document)
        .map(row => parseFsDoc(row.document))
        .sort((a, b) => new Date(b.startsAt || 0) - new Date(a.startsAt || 0));
}

// Planner web config (public) — opens a second, read-only Firestore connection so
// the public page can subscribe to a linked event's tables in real time.
const plannerFirebaseConfig = {
    apiKey: "AIzaSyDJYFPuNFgrhGCQQR6_X1IE4QqYDwZ6Vfk",
    authDomain: "dfwgv-planner.firebaseapp.com",
    projectId: PLANNER_PROJECT_ID,
    appId: "1:699390463926:web:b47c0402e1b170c2233b17"
};

let plannerDbInstance = null;
const getPlannerDb = () => {
    if (!plannerDbInstance) {
        plannerDbInstance = getFirestore(initializeApp(plannerFirebaseConfig, 'dfwgv-planner'));
    }
    return plannerDbInstance;
};

// Firestore Timestamps, ISO strings, or Dates → Date (or null)
const toDateSafe = (value) => {
    if (!value) return null;
    if (typeof value.toDate === 'function') return value.toDate();
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
};

// Firebase Context now only provides db and auth instance, and appId
const FirebaseContext = createContext(null);

// Custom hook for debouncing a value
const useDebounce = (value, delay) => {
    const [debouncedValue, setDebouncedValue] = useState(value);

    useEffect(() => {
        const handler = setTimeout(() => {
            setDebouncedValue(value);
        }, delay);

        return () => {
            clearTimeout(handler);
        };
    }, [value, delay]);

    return debouncedValue;
};

// Custom Message Box component instead of alert/confirm
const MessageBox = memo(({ message, type, onClose, onConfirm }) => {
    if (!message) return null;

    return (
        <div className="dfwgv-modal-overlay fixed inset-0 flex items-center justify-center z-50 p-4">
            <div className="dfwgv-modal-panel bg-gray-800 rounded-lg shadow-xl p-6 max-w-sm w-full border border-gray-700">
                <p className="text-gray-100 text-lg mb-4">{message}</p>
                <div className="flex justify-end space-x-3">
                    {type === 'confirm' && (
                        <button onClick={onConfirm} className="dfwgv-btn dfwgv-btn-primary">
                            Confirm
                        </button>
                    )}
                    <button onClick={onClose} className="dfwgv-btn dfwgv-btn-secondary">
                        {type === 'confirm' ? 'Cancel' : 'Close'}
                    </button>
                </div>
            </div>
        </div>
    );
});

// Non-blocking success/info toasts (bottom-right stack, auto-dismissed by App)
const ToastStack = memo(({ toasts }) => {
    if (!toasts.length) return null;
    return (
        <div className="dfwgv-toasts" role="status" aria-live="polite">
            {toasts.map(toast => (
                <div key={toast.id} className="dfwgv-toast">{toast.text}</div>
            ))}
        </div>
    );
});

// Modal that requires typing a phrase before a destructive action runs
const TypeConfirmModal = memo(({ title, description, phrase, onConfirm, onClose, loading }) => {
    const [typed, setTyped] = useState('');
    const matches = typed.trim() === phrase;

    return (
        <div className="dfwgv-modal-overlay fixed inset-0 flex items-center justify-center z-50 p-4">
            <div className="dfwgv-modal-panel bg-gray-800 rounded-lg shadow-xl p-6 max-w-md w-full border border-gray-700">
                <h2 className="text-xl font-semibold text-red-400 mb-2">{title}</h2>
                <p className="text-gray-300 mb-4">{description}</p>
                <p className="text-gray-300 mb-2 text-sm">Type <span className="font-bold text-gray-100">{phrase}</span> to confirm:</p>
                <input
                    type="text"
                    className="w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 mb-4"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    autoFocus
                />
                <div className="flex justify-end space-x-3">
                    <button
                        onClick={() => { if (matches) onConfirm(); }}
                        className="dfwgv-btn dfwgv-btn-danger"
                        disabled={!matches || loading}
                    >
                        {title}
                    </button>
                    <button onClick={onClose} className="dfwgv-btn dfwgv-btn-secondary" disabled={loading}>
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    );
});

// Shared game row used by Home, Library, Checked Out, and Removed pages.
// primary: { label, onClick, tone: 'primary'|'secondary', disabled, title }
// pill: { label, tone: 'ok'|'out'|'muted' } — also drives the row's edge stripe
// menuItems: [{ label, onClick, danger }] rendered behind the ⋯ button
const GameRow = memo(({ game, metaItems, pill, primary, menuItems }) => {
    const [menuOpen, setMenuOpen] = useState(false);

    const stripe = pill?.tone === 'out' ? 'out' : pill?.tone === 'ok' ? '' : 'neutral';

    return (
        <li className={`dfwgv-game-row ${stripe}`}>
            <img
                src={game.thumbnail || `https://placehold.co/80x80/18181c/b8b8c2?text=No+Img`}
                alt={game.name}
                className="dfwgv-game-thumb"
                loading="lazy"
            />
            <div className="dfwgv-game-info">
                <div className="dfwgv-game-name">
                    {game.bggId ? (
                        <a href={`https://boardgamegeek.com/boardgame/${game.bggId}`} target="_blank" rel="noopener noreferrer">
                            {game.name}
                        </a>
                    ) : (
                        game.name
                    )}
                    {game.ownerName ? <span className="dfwgv-owner-chip">{game.ownerName}</span> : null}
                </div>
                <div className="dfwgv-game-meta">
                    {metaItems.map((item, i) => <span key={i}>{item}</span>)}
                </div>
            </div>
            {pill ? <span className={`dfwgv-pill ${pill.tone}`}>{pill.label}</span> : null}
            <div className="dfwgv-game-actions">
                {primary ? (
                    <button
                        onClick={primary.onClick}
                        className={`dfwgv-btn ${primary.tone === 'secondary' ? 'dfwgv-btn-secondary' : 'dfwgv-btn-primary'}`}
                        disabled={primary.disabled}
                        title={primary.title || ''}
                    >
                        {primary.label}
                    </button>
                ) : null}
                {menuItems && menuItems.length > 0 ? (
                    <div className="dfwgv-more-wrap">
                        <button
                            className="dfwgv-more"
                            onClick={() => setMenuOpen(open => !open)}
                            aria-label={`More actions for ${game.name}`}
                            aria-expanded={menuOpen}
                        >
                            ⋯
                        </button>
                        {menuOpen && (
                            <>
                                <button className="dfwgv-menu-backdrop" aria-label="Close menu" onClick={() => setMenuOpen(false)} />
                                <div className="dfwgv-menu">
                                    {menuItems.map((item, i) => (
                                        <button
                                            key={i}
                                            className={item.danger ? 'danger' : ''}
                                            onClick={() => { setMenuOpen(false); item.onClick(); }}
                                        >
                                            {item.label}
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>
                ) : null}
            </div>
        </li>
    );
});

/**
 * Helper function to perform a fetch request with exponential backoff retries.
 * This can help mitigate transient network issues or API rate limits.
 * @param {string} url - The URL to fetch.
 * @param {object} options - Fetch options (e.g., method, headers).
 * @param {number} retries - Maximum number of retries.
 * @param {number} delay - Initial delay in milliseconds before the first retry.
 * @returns {Promise<Response>} The fetch response.
 * @throws {Error} If the fetch fails after all retries.
 */
async function retryFetch(url, options = {}, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            // If response is not OK but not a network error (e.g., 429 Too Many Requests),
            // still consider retrying if it's the last attempt, otherwise re-throw.
            if (!response.ok && response.status === 429 && i < retries - 1) {
                // console.warn(`[retryFetch] Rate limited (429) for ${url}. Retrying in ${delay}ms...`); // Removed for performance
                await new Promise(res => setTimeout(res, delay));
                delay *= 2; // Exponential backoff
                continue;
            }
            return response;
        } catch (error) {
            if (i < retries - 1) {
                // console.warn(`[retryFetch] Fetch failed for ${url} (attempt ${i + 1}/${retries}). Retrying in ${delay}ms...`, error); // Removed for performance
                await new Promise(res => setTimeout(res, delay));
                delay *= 2; // Exponential backoff
            } else {
                throw error; // Re-throw the error after all retries are exhausted
            }
        }
    }
    throw new Error("Max retries exceeded for fetch operation.");
}

// FirebaseSetup component (initializes Firebase app and its core services)
const FirebaseSetup = ({ children }) => {
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null); // auth instance
    const [loadingFirebase, setLoadingFirebase] = useState(true);

    useEffect(() => {
        const app = initializeApp(firebaseConfig);
        const firestore = getFirestore(app);
        const firebaseAuth = FirebaseAuth.getAuth(app);

        setDb(firestore);
        setAuth(firebaseAuth);
        setLoadingFirebase(false);
    }, []);

    if (loadingFirebase) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-gray-900">
                <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-blue-500"></div>
                <p className="ml-4 text-lg text-gray-300">Loading application...</p>
            </div>
        );
    }

    return (
        <FirebaseContext.Provider value={{ db, auth, appId }}>
            {children}
        </FirebaseContext.Provider>
    );
};

// AuthContext (New) - Provides authentication state and functions
const AuthContext = createContext(null);

// AuthProvider (New Component) - Handles Firebase Authentication logic
const AuthProvider = ({ children }) => {
    /* global __initial_auth_token */ // Declare __initial_auth_token as a global for ESLint
    const { auth } = useContext(FirebaseContext); // Get auth instance from FirebaseContext
    const [currentUser, setCurrentUser] = useState(null);
    const [loadingAuth, setLoadingAuth] = useState(true); // For initial auth check and auth operations

    useEffect(() => {
        if (!auth) return;

        const unsubscribe = FirebaseAuth.onAuthStateChanged(auth, async (user) => {
            if (user) {
                setCurrentUser(user);
            } else {
                // Only the Canvas/custom-token environment may bootstrap a user.
                // Public deployments should stay on the login screen until a
                // configured Firebase Auth user signs in explicitly.
                if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                    try {
                        await FirebaseAuth.signInWithCustomToken(auth, __initial_auth_token);
                    }
                    /* eslint-disable-next-line no-empty */
                    catch (error) {
                        console.error("Error during custom token authentication:", error);
                    }
                }
                setCurrentUser(null);
            }
            setLoadingAuth(false);
        });

        return () => unsubscribe();
    }, [auth]);

    // Removed signup function as per user request to disable self-registration
    const login = async (email, password) => {
        setLoadingAuth(true);
        try {
            const userCredential = await FirebaseAuth.signInWithEmailAndPassword(auth, email, password);
            return { success: true, user: userCredential.user };
        } catch (error) {
            console.error("Error logging in:", error);
            return { success: false, error: error.message };
        } finally {
            setLoadingAuth(false);
        }
    };

    const logout = async () => {
        setLoadingAuth(true);
        try {
            await FirebaseAuth.signOut(auth);
            return { success: true };
        } catch (error) {
            console.error("Error logging out:", error);
            return { success: false, error: error.message };
        } finally {
            setLoadingAuth(false);
        }
    };

    return (
        <AuthContext.Provider value={{ currentUser, loadingAuth, login, logout }}>
            {children}
        </AuthContext.Provider>
    );
};

// AuthPage component for login form only
const AuthPage = memo(({ login, loadingAuth, showMessage }) => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (loadingAuth) return;

        if (!email || !password) {
            showMessage("Email and password are required.", 'error');
            return;
        }

        const result = await login(email, password);
        if (!result.success) {
            showMessage(`Login failed: ${result.error}`, 'error');
        }
    };

    return (
        <div className="flex flex-col items-center justify-center min-h-screen-minus-header bg-gray-900 p-4">
            <div className="bg-gray-800 p-8 rounded-xl shadow-lg w-full max-w-md border border-gray-700">
                <h2 className="text-3xl font-bold text-blue-400 mb-6 text-center">Login</h2>
                <form onSubmit={handleSubmit} className="space-y-5">
                    <div>
                        <label htmlFor="email" className="block text-sm font-medium text-gray-300 mb-1">Email</label>
                        <input
                            type="email"
                            id="email"
                            className="w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 placeholder-gray-400 focus:ring-blue-500 focus:border-blue-500"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                        />
                    </div>
                    <div>
                        <label htmlFor="password" className="block text-sm font-medium text-gray-300 mb-1">Password</label>
                        <input
                            type="password"
                            id="password"
                            className="w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 placeholder-gray-400 focus:ring-blue-500 focus:border-blue-500"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                        />
                    </div>
                    <button
                        type="submit"
                        className="dfwgv-btn dfwgv-btn-primary w-full text-lg"
                        disabled={loadingAuth}
                    >
                        {loadingAuth ? 'Logging in...' : 'Login'}
                    </button>
                </form>
            </div>
        </div>
    );
});

// Convention context chip: shows the active convention on every page and doubles as a switcher.
const ConventionChip = memo(({ conventions, currentConvention, setCurrentConventionId, goToConventions }) => {
    const [open, setOpen] = useState(false);

    const sortedConventions = useMemo(() => {
        return [...conventions].sort((a, b) => new Date(b.startDate) - new Date(a.startDate));
    }, [conventions]);

    const formatDates = (conv) =>
        `${new Date(conv.startDate).toLocaleDateString()} – ${new Date(conv.endDate).toLocaleDateString()}`;

    return (
        <div className="dfwgv-con-wrap">
            <button
                className={`dfwgv-con-chip ${currentConvention ? '' : 'none'}`}
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
                title={currentConvention ? `${currentConvention.name} (${formatDates(currentConvention)})` : 'Select a convention'}
            >
                {currentConvention ? currentConvention.name : 'No convention selected'}
                <span className="caret">▾</span>
            </button>
            {open && (
                <>
                    <button className="dfwgv-menu-backdrop" aria-label="Close menu" onClick={() => setOpen(false)} />
                    <div className="dfwgv-con-menu">
                        {sortedConventions.map(conv => (
                            <button
                                key={conv.id}
                                className={currentConvention?.id === conv.id ? 'selected' : ''}
                                onClick={() => { setCurrentConventionId(conv.id); setOpen(false); }}
                            >
                                {conv.name}
                                <span className="dates">{formatDates(conv)}</span>
                            </button>
                        ))}
                        {currentConvention && (
                            <button onClick={() => { setCurrentConventionId(null); setOpen(false); }}>
                                Deselect convention
                            </button>
                        )}
                        <button onClick={() => { goToConventions(); setOpen(false); }}>
                            Manage conventions →
                        </button>
                    </div>
                </>
            )}
        </div>
    );
});

const AppTopbar = memo(({ currentUser, logout, conventions, currentConvention, setCurrentConventionId, goToConventions }) => (
    <header className="dfwgv-topbar">
        <div className="dfwgv-brand">
            <a className="dfwgv-logo" href="https://www.dfwgamingvillage.com/" aria-label="Go to DFW Gaming Village home">
                <img src={`${process.env.PUBLIC_URL}/dfwgv-icon.png`} alt="DFW Gaming Village logo" />
            </a>
            <div className="dfwgv-brandText">
                <div className="dfwgv-title">DFWGV Library Manager</div>
                <div className="dfwgv-subtitle">Board game library and convention checkouts</div>
            </div>
        </div>
        <div className="dfwgv-authbar">
            {currentUser ? (
                <>
                    <ConventionChip
                        conventions={conventions}
                        currentConvention={currentConvention}
                        setCurrentConventionId={setCurrentConventionId}
                        goToConventions={goToConventions}
                    />
                    <div className="dfwgv-authStatus" title={currentUser.email || currentUser.uid}>
                        {currentUser.email || currentUser.uid}
                    </div>
                    <button
                        onClick={logout}
                        className="dfwgv-topbarButton"
                    >
                        Logout
                    </button>
                </>
            ) : (
                <div className="dfwgv-authStatus">Library access</div>
            )}
        </div>
    </header>
));


// Home View Component definition
const HomeView = memo(({
    loading,
    currentConvention,
    exportConventionGamesToCsv, toggleGameForConvention, toggleGameConventionCheckout, showMessage, setCurrentConventionId,
    homeSearchInputRef, homeSearchTerm, setHomeSearchTerm, gamesByIdMap, conventions, goToConventions, copyPublicLink
}) => {
    const debouncedHomeSearchTerm = useDebounce(homeSearchTerm, 300); // Debounce search input
    const [showTopCheckouts, setShowTopCheckouts] = useState(false);
    const [homeOwner, setHomeOwner] = useState('All');
    const [homeSort, setHomeSort] = useState('name');

    const homeOwners = useMemo(() => {
        const owners = new Set((currentConvention?.games || []).map(g => String(g?.ownerName || '')).filter(Boolean));
        return ['All', ...[...owners].sort()];
    }, [currentConvention?.games]);

    // Filter games from the current convention based on search term
    const gamesInCurrentConventionFilteredBySearch = useMemo(() => {
        if (!currentConvention) return [];

        const filtered = currentConvention.games.filter(convGame => {
            if (!convGame || typeof convGame.id === 'undefined') {
                return false;
            }

            const fullGameData = gamesByIdMap.get(convGame.id);

            let gameName = '';
            if (fullGameData && typeof fullGameData.name === 'string') {
                gameName = fullGameData.name;
            } else if (typeof convGame.name === 'string') {
                gameName = convGame.name;
            }

            let ownerName = '';
            if (fullGameData && typeof fullGameData.ownerName === 'string') {
                ownerName = fullGameData.ownerName;
            } else if (typeof convGame.ownerName === 'string') {
                ownerName = convGame.ownerName;
            }

            const searchLower = String(debouncedHomeSearchTerm).toLowerCase();

            const matchesSearch = (
                gameName.toLowerCase().includes(searchLower) ||
                ownerName.toLowerCase().includes(searchLower)
            );
            const matchesOwner = homeOwner === 'All' || ownerName === homeOwner;
            return matchesSearch && matchesOwner;
        });

        return filtered.sort((a, b) => {
            if (homeSort === 'rating') {
                const ratingA = gamesByIdMap.get(a.id)?.averageRating ?? a.averageRating ?? -1;
                const ratingB = gamesByIdMap.get(b.id)?.averageRating ?? b.averageRating ?? -1;
                return ratingB - ratingA;
            }
            if (homeSort === 'checkouts') {
                return (b.conventionCheckoutCount || 0) - (a.conventionCheckoutCount || 0);
            }
            const nameA = gamesByIdMap.get(a.id)?.name || a.name;
            const nameB = gamesByIdMap.get(b.id)?.name || b.name;
            return String(nameA).localeCompare(String(nameB));
        });
    }, [currentConvention, gamesByIdMap, debouncedHomeSearchTerm, homeOwner, homeSort]);

    const totalConventionCheckouts = useMemo(() => {
        if (!currentConvention?.games) return 0;
        return currentConvention.games.reduce((sum, g) => sum + (g.conventionCheckoutCount || 0), 0);
    }, [currentConvention?.games]);

    const topConventionCheckouts = useMemo(() => {
        if (!currentConvention?.games) return [];
        const list = currentConvention.games
            .map(g => ({
                id: g.id,
                name: (gamesByIdMap.get(g.id)?.name ?? g.name ?? 'Unknown'),
                ownerName: (gamesByIdMap.get(g.id)?.ownerName ?? g.ownerName ?? ''),
                count: g.conventionCheckoutCount || 0,
            }))
            .filter(x => x.count > 0)
            .sort((a, b) => b.count - a.count);
        if (list.length <= 10) return list;
        const cutoff = list[9].count;
        return list.filter(x => x.count >= cutoff);
    }, [currentConvention?.games, gamesByIdMap]);

    const dailyConventionCheckoutTotals = useMemo(() => {
        if (!currentConvention?.games || !currentConvention.startDate || !currentConvention.endDate) return [];

        const toDateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        const start = new Date(currentConvention.startDate);
        const end = new Date(currentConvention.endDate);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];

        const counts = new Map();
        const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        const lastDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
        while (cursor <= lastDay) {
            counts.set(toDateKey(cursor), 0);
            cursor.setDate(cursor.getDate() + 1);
        }

        let timestampedCheckouts = 0;
        for (const g of currentConvention.games) {
            const times = Array.isArray(g.conventionCheckoutTimes) ? g.conventionCheckoutTimes : [];
            for (const iso of times) {
                const d = new Date(iso);
                if (Number.isNaN(d.getTime())) continue;
                const key = toDateKey(d);
                if (counts.has(key)) {
                    counts.set(key, counts.get(key) + 1);
                    timestampedCheckouts += 1;
                }
            }
        }
        const unassignedCount = Math.max(totalConventionCheckouts - timestampedCheckouts, 0);
        return Array.from(counts.entries()).map(([date, count]) => ({ date, count, isUnassigned: false }))
            .concat(unassignedCount > 0 ? [{ date: 'unassigned', count: unassignedCount, isUnassigned: true }] : []);
    }, [currentConvention?.games, currentConvention?.startDate, currentConvention?.endDate, totalConventionCheckouts]);

    const checkedOutNowCount = useMemo(() => {
        if (!currentConvention?.games) return 0;
        return currentConvention.games.filter(g => g?.isCheckedOutAtConvention).length;
    }, [currentConvention?.games]);

    const busiestDay = useMemo(() => {
        const dated = dailyConventionCheckoutTotals.filter(row => !row.isUnassigned && row.count > 0);
        if (dated.length === 0) return null;
        return dated.reduce((max, row) => (row.count > max.count ? row : max));
    }, [dailyConventionCheckoutTotals]);

    const maxDailyCount = useMemo(() => {
        return Math.max(1, ...dailyConventionCheckoutTotals.map(row => row.count));
    }, [dailyConventionCheckoutTotals]);

    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const formatDayLabel = (dateKey) => {
        const d = new Date(dateKey + 'T00:00:00');
        return d.toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' });
    };

    return (
        <div className="w-full max-w-4xl">
            <section className="bg-gray-800 p-6 rounded-xl shadow-lg mb-8 w-full border border-gray-700">
                {!currentConvention ? (
                    <div className="dfwgv-empty">
                        <h3>Pick a convention to get started</h3>
                        <p>Checkouts, stats, and the convention game list all live under a convention.</p>
                        {conventions.length === 0 ? (
                            <button onClick={goToConventions} className="dfwgv-btn dfwgv-btn-primary">
                                Create your first convention
                            </button>
                        ) : (
                            <div className="dfwgv-con-picker">
                                {[...conventions]
                                    .sort((a, b) => new Date(b.startDate) - new Date(a.startDate))
                                    .map(conv => (
                                        <button key={conv.id} className="dfwgv-con-pick" onClick={() => setCurrentConventionId(conv.id)}>
                                            <span>{conv.name}</span>
                                            <span className="dates">
                                                {new Date(conv.startDate).toLocaleDateString()} – {new Date(conv.endDate).toLocaleDateString()}
                                            </span>
                                        </button>
                                    ))}
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="flex flex-col gap-5">
                        <h2 className="text-2xl font-semibold text-gray-100 m-0">
                            {currentConvention.name}
                            <span className="ml-3 text-sm font-normal text-gray-300">
                                {new Date(currentConvention.startDate).toLocaleDateString()} – {new Date(currentConvention.endDate).toLocaleDateString()}
                            </span>
                        </h2>

                        <div className="dfwgv-stat-row">
                            <div className="dfwgv-stat">
                                <div className="k">Games at convention</div>
                                <div className="v">{currentConvention.games?.length || 0}</div>
                            </div>
                            <div className="dfwgv-stat">
                                <div className="k">Checked out now</div>
                                <div className="v">{checkedOutNowCount}</div>
                            </div>
                            <div className="dfwgv-stat">
                                <div className="k">Total checkouts</div>
                                <div className="v">{totalConventionCheckouts}</div>
                            </div>
                            <div className="dfwgv-stat">
                                <div className="k">Busiest day</div>
                                <div className="v">
                                    {busiestDay ? (
                                        <>
                                            {new Date(busiestDay.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' })}
                                            {' '}<small>· {busiestDay.count}</small>
                                        </>
                                    ) : '—'}
                                </div>
                            </div>
                        </div>

                        <div className="dfwgv-chart-card">
                            <div className="dfwgv-chart-head">
                                <span>Checkouts by day</span>
                                <button
                                    onClick={() => setShowTopCheckouts(true)}
                                    className="dfwgv-btn dfwgv-btn-secondary dfwgv-btn-sm"
                                    title="Show most-checked-out games for this convention"
                                >
                                    Top checkouts
                                </button>
                            </div>
                            {dailyConventionCheckoutTotals.length === 0 ? (
                                <p className="text-gray-400 m-0">No checkout activity yet.</p>
                            ) : (
                                <div className="dfwgv-bars">
                                    {dailyConventionCheckoutTotals.map(row => (
                                        <div
                                            key={row.date}
                                            className={`dfwgv-bar ${row.isUnassigned ? 'unassigned' : ''} ${row.date === todayKey ? 'today' : ''}`}
                                            title={row.isUnassigned ? 'Checkouts recorded before daily tracking was added' : formatDayLabel(row.date)}
                                        >
                                            <span className="n">{row.count}</span>
                                            <div className="fill" style={{ height: `${Math.round((row.count / maxDailyCount) * 100)}%` }}></div>
                                            <span className="d">{row.isUnassigned ? 'Older' : formatDayLabel(row.date)}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="flex flex-wrap items-center gap-3">
                            <input
                                type="text"
                                placeholder={`Search ${currentConvention.games?.length || 0} games at ${currentConvention.name}...`}
                                className="flex-grow p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 placeholder-gray-400"
                                style={{ flexBasis: '220px' }}
                                value={homeSearchTerm}
                                onChange={(e) => setHomeSearchTerm(e.target.value)}
                                ref={homeSearchInputRef}
                            />
                            <select
                                className="p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100"
                                value={homeOwner}
                                onChange={(e) => setHomeOwner(e.target.value)}
                                aria-label="Filter by owner"
                            >
                                {homeOwners.map(owner => (
                                    <option key={owner} value={owner}>{owner === 'All' ? 'All owners' : owner}</option>
                                ))}
                            </select>
                            <select
                                className="p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100"
                                value={homeSort}
                                onChange={(e) => setHomeSort(e.target.value)}
                                aria-label="Sort games"
                            >
                                <option value="name">Sort: Name</option>
                                <option value="rating">Sort: Rating</option>
                                <option value="checkouts">Sort: Checkouts</option>
                            </select>
                            <button
                                onClick={exportConventionGamesToCsv}
                                className="dfwgv-btn dfwgv-btn-secondary"
                                disabled={loading || gamesInCurrentConventionFilteredBySearch.length === 0}
                            >
                                Export CSV
                            </button>
                            <button
                                onClick={() => copyPublicLink(currentConvention)}
                                className="dfwgv-btn dfwgv-btn-secondary"
                                title="Copy a read-only link that shows this convention's games and live availability"
                            >
                                🔗 Public link
                            </button>
                        </div>

                        <div className="scrollable-list bg-gray-700 p-3 border border-gray-600">
                            {gamesInCurrentConventionFilteredBySearch.length === 0 ? (
                                <p className="text-gray-400">No games found matching your search in this convention.</p>
                            ) : (
                                <ul className="space-y-3 list-none p-0 m-0">
                                    {gamesInCurrentConventionFilteredBySearch.map(convGame => {
                                        if (!convGame || typeof convGame.id === 'undefined') {
                                            return null;
                                        }

                                        const fullGameData = gamesByIdMap.get(convGame.id);
                                        const displayMinPlayers = fullGameData?.minPlayers || convGame.minPlayers || '?';
                                        const displayMaxPlayers = fullGameData?.maxPlayers || convGame.maxPlayers || '?';
                                        const displayPlayingTime = fullGameData?.playingTime || convGame.playingTime || '?';
                                        const ratingValue = fullGameData?.averageRating ?? convGame.averageRating;
                                        const displayAverageRating = (typeof ratingValue === 'number') ? ratingValue.toFixed(1) : 'N/A';
                                        const isOut = !!convGame.isCheckedOutAtConvention;

                                        return (
                                            <GameRow
                                                key={convGame.id}
                                                game={convGame}
                                                metaItems={[
                                                    `👥 ${displayMinPlayers}–${displayMaxPlayers}`,
                                                    `⏱ ${displayPlayingTime} min`,
                                                    <><span className="star">★</span> {displayAverageRating}</>,
                                                    `×${convGame.conventionCheckoutCount || 0} checkouts`,
                                                ]}
                                                pill={isOut ? { label: 'Checked out', tone: 'out' } : { label: 'Available', tone: 'ok' }}
                                                primary={{
                                                    label: isOut ? 'Check In' : 'Check Out',
                                                    tone: isOut ? 'secondary' : 'primary',
                                                    onClick: () => toggleGameConventionCheckout(convGame, currentConvention.id),
                                                    disabled: loading,
                                                }}
                                                menuItems={[
                                                    {
                                                        label: 'Remove from convention',
                                                        danger: true,
                                                        onClick: () => toggleGameForConvention(convGame, currentConvention.id),
                                                    },
                                                ]}
                                            />
                                        );
                                    })}
                                </ul>
                            )}
                        </div>
                    </div>
                )}
            </section>
            {showTopCheckouts && (
                <div className="dfwgv-modal-overlay fixed inset-0 flex items-center justify-center p-4">
                    <div className="dfwgv-modal-panel bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-lg border border-gray-700">
                        <div className="dfwgv-modal-header flex items-start justify-between gap-4 mb-4">
                            <h4 className="text-xl font-semibold text-blue-300">
                                Top checkouts - {currentConvention?.name}
                            </h4>
                            <button
                                onClick={() => setShowTopCheckouts(false)}
                                className="px-3 py-1 bg-gray-600 hover:bg-gray-700 text-gray-100 rounded"
                            >
                                Close
                            </button>
                        </div>

                        {topConventionCheckouts.length === 0 ? (
                            <p className="text-gray-300">No checkouts yet for this convention.</p>
                        ) : (
                            <ul className="dfwgv-modal-scroll divide-y divide-gray-700">
                                {topConventionCheckouts.map((g, i) => (
                                    <li key={g.id} className="dfwgv-top-checkout-row py-2 flex items-center justify-between">
                                        <div className="flex items-center gap-3 min-w-0">
                                            <span className="text-gray-400 w-6 text-right">{i + 1}.</span>
                                            <div className="flex flex-col min-w-0">
                                                <span className="text-gray-100 font-medium">{g.name}</span>
                                                {g.ownerName ? (
                                                    <span className="text-xs text-gray-400">Owner: {g.ownerName}</span>
                                                ) : null}
                                            </div>
                                        </div>
                                        <span className="text-gray-100 font-semibold">{g.count}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
});

// Import Collections Page Component definition
const ImportCollectionsPage = memo(({ importGames, loading, showMessage, importStatus, importResults }) => {
    const [owner1BggUsername, setOwner1BggUsername] = useState('');
    const [owner2BggUsername, setOwner2BggUsername] = useState('');

    const handleImportGames = () => {
        if (!owner1BggUsername.trim() && !owner2BggUsername.trim()) {
            showMessage("Enter at least one BGG username to import.", 'error');
            return;
        }
        importGames(owner1BggUsername.trim(), owner2BggUsername.trim());
    };

    return (
        <section className="bg-gray-800 p-6 rounded-xl shadow-lg mb-8 w-full max-w-4xl border border-gray-700">
            <h2 className="text-2xl font-semibold text-gray-100 mb-2">Import BoardGameGeek Collections</h2>
            <p className="text-gray-300 mb-4 text-sm">
                Pulls each owner's collection from BGG (expansions excluded). Games already in the library
                keep their checkout history; only changed details are updated.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                <div>
                    <label htmlFor="owner1Bgg" className="block text-sm font-medium text-gray-300 mb-1">Owner 1 BGG Username</label>
                    <input
                        type="text"
                        id="owner1Bgg"
                        className="w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 placeholder-gray-400"
                        value={owner1BggUsername}
                        onChange={(e) => setOwner1BggUsername(e.target.value)}
                        placeholder="e.g., bgg_user_one"
                    />
                </div>
                <div>
                    <label htmlFor="owner2Bgg" className="block text-sm font-medium text-gray-300 mb-1">Owner 2 BGG Username</label>
                    <input
                        type="text"
                        id="owner2Bgg"
                        className="w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 placeholder-gray-400"
                        value={owner2BggUsername}
                        onChange={(e) => setOwner2BggUsername(e.target.value)}
                        placeholder="e.g., bgg_user_two"
                    />
                </div>
            </div>
            <button
                onClick={handleImportGames}
                className="dfwgv-btn dfwgv-btn-primary w-full text-lg"
                disabled={loading}
            >
                {loading && importStatus ? 'Importing…' : 'Import Games from BoardGameGeek'}
            </button>

            {importStatus && (
                <div className="dfwgv-import-status">
                    <span className="spin" aria-hidden="true"></span>
                    <span>{importStatus}</span>
                </div>
            )}

            {!importStatus && importResults.length > 0 && (
                <ul className="dfwgv-import-results">
                    {importResults.map((result, i) => (
                        <li key={i} className={result.error ? 'failed' : ''}>
                            <b>{result.username}:</b>{' '}
                            {result.error ? (
                                <span className="detail">{result.error}</span>
                            ) : (
                                <span className="detail">
                                    {result.fetched} games in collection · {result.added} added · {result.updated} updated
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
});

// AddCustomGameModal Component
const AddCustomGameModal = memo(({ onClose, onSave, loading, showMessage }) => {
    const [name, setName] = useState('');
    const [ownerName, setOwnerName] = useState('');
    const [bggId, setBggId] = useState('');
    const [thumbnail, setThumbnail] = useState('');
    const [image, setImage] = useState('');
    const [minPlayers, setMinPlayers] = useState('');
    const [maxPlayers, setMaxPlayers] = useState('');
    const [playingTime, setPlayingTime] = useState('');
    const [averageRating, setAverageRating] = useState('');

    const handleSave = () => {
        if (!name.trim() || !ownerName.trim()) {
            showMessage("Game Name and Owner Name are required.", 'info');
            return;
        }

        const newGameData = {
            name: name.trim(),
            ownerName: ownerName.trim(),
            bggId: bggId.trim() || null,
            thumbnail: thumbnail.trim() || '',
            image: image.trim() || '',
            minPlayers: minPlayers ? parseInt(minPlayers) : null,
            maxPlayers: maxPlayers ? parseInt(maxPlayers) : null,
            playingTime: playingTime ? parseInt(playingTime) : null,
            averageRating: averageRating ? parseFloat(averageRating) : null,
        };
        onSave(newGameData);
    };

    return (
        <div className="dfwgv-modal-overlay fixed inset-0 flex items-center justify-center z-50 p-4">
            <div className="dfwgv-modal-panel bg-gray-800 rounded-lg shadow-xl p-6 max-w-lg w-full border border-gray-700 overflow-y-auto max-h-[90vh]">
                <h2 className="text-2xl font-semibold text-gray-100 mb-4">Add Custom Game</h2>
                <div className="flex flex-col gap-4 mb-4">
                    <label className="block text-sm font-medium text-gray-300">
                        Game Name: <span className="text-red-500">*</span>
                        <input
                            type="text"
                            className="mt-1 w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 focus:ring-blue-500 focus:border-blue-500"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            required
                        />
                    </label>
                    <label className="block text-sm font-medium text-gray-300">
                        Owner Name: <span className="text-red-500">*</span>
                        <input
                            type="text"
                            className="mt-1 w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 focus:ring-blue-500 focus:border-blue-500"
                            value={ownerName}
                            onChange={(e) => setOwnerName(e.target.value)}
                            required
                        />
                    </label>
                    <label className="block text-sm font-medium text-gray-300">
                        BGG ID:
                        <input
                            type="text"
                            className="mt-1 w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 focus:ring-blue-500 focus:border-blue-500"
                            value={bggId}
                            onChange={(e) => setBggId(e.target.value)}
                            placeholder="e.g., 174436"
                        />
                    </label>
                    <label className="block text-sm font-medium text-gray-300">
                        Thumbnail URL:
                        <input
                            type="text"
                            className="mt-1 w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 focus:ring-blue-500 focus:border-blue-500"
                            value={thumbnail}
                            onChange={(e) => setThumbnail(e.target.value)}
                            placeholder="e.g., https://cf.geekdo-images.com/thumb/img.jpg"
                        />
                    </label>
                    <label className="block text-sm font-medium text-gray-300">
                        Image URL:
                        <input
                            type="text"
                            className="mt-1 w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 focus:ring-blue-500 focus:border-blue-500"
                            value={image}
                            onChange={(e) => setImage(e.target.value)}
                            placeholder="e.g., https://cf.geekdo-images.com/image/img.jpg"
                        />
                    </label>
                    <label className="block text-sm font-medium text-gray-300">
                        Min Players:
                        <input
                            type="number"
                            className="mt-1 w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 focus:ring-blue-500 focus:border-blue-500"
                            value={minPlayers}
                            onChange={(e) => setMinPlayers(e.target.value)}
                            placeholder="e.g., 1"
                        />
                    </label>
                    <label className="block text-sm font-medium text-gray-300">
                        Max Players:
                        <input
                            type="number"
                            className="mt-1 w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 focus:ring-blue-500 focus:border-blue-500"
                            value={maxPlayers}
                            onChange={(e) => setMaxPlayers(e.target.value)}
                            placeholder="e.g., 4"
                        />
                    </label>
                    <label className="block text-sm font-medium text-gray-300">
                        Playing Time (min):
                        <input
                            type="number"
                            className="mt-1 w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 focus:ring-blue-500 focus:border-blue-500"
                            value={playingTime}
                            onChange={(e) => setPlayingTime(e.target.value)}
                            placeholder="e.g., 60"
                        />
                    </label>
                    <label className="block text-sm font-medium text-gray-300">
                        Average Rating:
                        <input
                            type="number"
                            step="0.01"
                            className="mt-1 w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 focus:ring-blue-500 focus:border-blue-500"
                            value={averageRating}
                            onChange={(e) => setAverageRating(e.target.value)}
                            placeholder="e.g., 7.5"
                        />
                    </label>
                </div>
                <div className="flex justify-end space-x-3">
                    <button
                        onClick={handleSave}
                        className="dfwgv-btn dfwgv-btn-primary"
                        disabled={loading}
                    >
                        Save Game
                    </button>
                    <button
                        onClick={onClose}
                        className="dfwgv-btn dfwgv-btn-secondary"
                        disabled={loading}
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    );
});


// Game Library Page Component definition
const GameLibraryPage = memo(({
    games, toggleGameForConvention, currentConvention, loading, showMessage, removeGameFromLibrary, onAddCustomGame,
    librarySearchInputRef, searchTerm, setSearchTerm, gamesByIdMap
}) => {
    // --- MOVED STATE DECLARATIONS TO TOP ---
    const scrollRef = useRef(0);
    const scrollPosition = useRef(0);
    const [selectedOwner, setSelectedOwner] = useState('All');
    const [librarySort, setLibrarySort] = useState('name');
    // --- END MOVED STATE DECLARATIONS ---

    const debouncedSearchTerm = useDebounce(searchTerm, 300);

    useEffect(() => {
        const handleScroll = () => {
            if (scrollRef.current) {
                scrollPosition.current = scrollRef.current.scrollTop;
            }
        };

        const currentScrollRef = scrollRef.current;
        if (currentScrollRef) {
            currentScrollRef.addEventListener('scroll', handleScroll);
            currentScrollRef.scrollTop = scrollPosition.current;
        }

        return () => {
            if (currentScrollRef) {
                currentScrollRef.removeEventListener('scroll', handleScroll);
            }
        };
    }, [games, debouncedSearchTerm, selectedOwner]);


    const uniqueOwners = ['All', ...new Set(games.map(game => String(game.ownerName || '')))].sort();


    // Filtered games now only include non-removed games, as expansions are excluded at import
    const libraryFilteredGames = useMemo(() => { // Memoize this computation
        return games.filter(game => {
            if (!game || typeof game.id === 'undefined') {
                return false;
            }
            
            const gameName = (typeof game.name === 'string' ? game.name : '');
            const ownerName = (typeof game.ownerName === 'string' ? game.ownerName : '');

            const debouncedSearchTermLower = String(debouncedSearchTerm).toLowerCase();

            return (
                !game.isRemoved &&
                (gameName.toLowerCase().includes(debouncedSearchTermLower) ||
                ownerName.toLowerCase().includes(debouncedSearchTermLower)) &&
                (selectedOwner === 'All' || ownerName === selectedOwner)
            );
        }).sort((a, b) => {
            if (librarySort === 'rating') {
                return (b.averageRating ?? -1) - (a.averageRating ?? -1);
            }
            if (librarySort === 'checkouts') {
                return (b.checkoutCount || 0) - (a.checkoutCount || 0);
            }
            return String(a.name || '').localeCompare(String(b.name || ''));
        });
    }, [games, debouncedSearchTerm, selectedOwner, librarySort]); // Dependencies for useMemo


    return (
        <section className="bg-gray-800 p-6 rounded-xl shadow-lg mb-8 w-full max-w-4xl border border-gray-700">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <h2 className="text-2xl font-semibold text-gray-100 m-0">Game Library</h2>
                <button
                    onClick={onAddCustomGame}
                    className="dfwgv-btn dfwgv-btn-secondary"
                    disabled={loading}
                >
                    Add Custom Game
                </button>
            </div>
            <div className="mb-4 flex flex-wrap gap-3">
                <input
                    type="text"
                    placeholder="Search games by name or owner..."
                    className="flex-grow p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 placeholder-gray-400"
                    style={{ flexBasis: '220px' }}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    ref={librarySearchInputRef}
                />
                <select
                    className="p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100"
                    value={selectedOwner}
                    onChange={(e) => setSelectedOwner(e.target.value)}
                    aria-label="Filter by owner"
                >
                    {uniqueOwners.map(owner => (
                        <option key={owner} value={owner}>{owner === 'All' ? 'All owners' : owner}</option>
                    ))}
                </select>
                <select
                    className="p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100"
                    value={librarySort}
                    onChange={(e) => setLibrarySort(e.target.value)}
                    aria-label="Sort games"
                >
                    <option value="name">Sort: Name</option>
                    <option value="rating">Sort: Rating</option>
                    <option value="checkouts">Sort: Checkouts</option>
                </select>
            </div>
            <p className="text-gray-300 mb-4">Total Games: {games.filter(g => !g.isRemoved).length} (showing {libraryFilteredGames.length} matching entries)</p>
            <div ref={scrollRef} className="scrollable-list bg-gray-700 p-3 border border-gray-600">
                {libraryFilteredGames.length === 0 ? (
                    <p className="text-gray-400">No games found matching your search, or no games imported yet.</p>
                ) : (
                    <ul className="space-y-3 list-none p-0 m-0">
                        {libraryFilteredGames.map(game => {
                            if (!game || typeof game.id === 'undefined') {
                                return null;
                            }
                            const isGameInCurrentConvention = currentConvention?.games?.some(g => g.id === game.id);
                            const isAddRemoveButtonDisabled = !currentConvention;

                            return (
                                <GameRow
                                    key={game.id}
                                    game={game}
                                    metaItems={[
                                        `👥 ${game.minPlayers || '?'}–${game.maxPlayers || '?'}`,
                                        `⏱ ${game.playingTime || '?'} min`,
                                        <><span className="star">★</span> {(typeof game.averageRating === 'number') ? game.averageRating.toFixed(1) : 'N/A'}</>,
                                        `×${game.checkoutCount || 0} checkouts`,
                                    ]}
                                    pill={
                                        isGameInCurrentConvention
                                            ? { label: 'At convention', tone: 'ok' }
                                            : { label: 'In library', tone: 'muted' }
                                    }
                                    primary={
                                        isGameInCurrentConvention
                                            ? {
                                                label: 'Remove from Convention',
                                                tone: 'secondary',
                                                onClick: () => toggleGameForConvention(game, currentConvention?.id),
                                                disabled: loading,
                                            }
                                            : {
                                                label: 'Add to Convention',
                                                tone: 'primary',
                                                onClick: () => toggleGameForConvention(game, currentConvention?.id),
                                                disabled: loading || isAddRemoveButtonDisabled,
                                                title: isAddRemoveButtonDisabled ? 'Select a convention first to add/remove games' : '',
                                            }
                                    }
                                    menuItems={[
                                        {
                                            label: 'Remove from Library',
                                            danger: true,
                                            onClick: () => showMessage(
                                                `Are you sure you want to remove "${game.name} (${game.ownerName})" from the library? It will be moved to the "Removed" tab, but its historical data will be preserved.`,
                                                'confirm',
                                                () => removeGameFromLibrary(game)
                                            ),
                                        },
                                    ]}
                                />
                            );
                        })}
                    </ul>
                )}
            </div>
        </section>
    );
});

// New Removed Games Page Component definition
const RemovedGamesPage = memo(({ removedGames, reAddGameToLibrary, loading, showMessage }) => {
    return (
        <section className="bg-gray-800 p-6 rounded-xl shadow-lg mb-8 w-full max-w-4xl border border-gray-700">
            <h2 className="text-2xl font-semibold text-gray-100 mb-2">Removed Games</h2>
            <p className="text-gray-300 mb-4 text-sm">Removed from the library but kept for their checkout history. Re-add a game to bring it back.</p>
            <div className="scrollable-list bg-gray-700 p-3 border border-gray-600">
                {removedGames.length === 0 ? (
                    <p className="text-gray-400">No games have been removed from the library yet.</p>
                ) : (
                    <ul className="space-y-3 list-none p-0 m-0">
                        {removedGames.map(game => {
                            if (!game || typeof game.id === 'undefined') {
                                return null;
                            }
                            return (
                                <GameRow
                                    key={game.id}
                                    game={game}
                                    metaItems={[
                                        <><span className="star">★</span> {(typeof game.averageRating === 'number') ? game.averageRating.toFixed(1) : 'N/A'}</>,
                                        `×${game.checkoutCount || 0} checkouts`,
                                    ]}
                                    pill={{ label: 'Removed', tone: 'muted' }}
                                    primary={{
                                        label: 'Re-add to Library',
                                        tone: 'primary',
                                        onClick: () => showMessage(
                                            `Are you sure you want to re-add "${game.name} (${game.ownerName})" to the main library?`,
                                            'confirm',
                                            () => reAddGameToLibrary(game)
                                        ),
                                        disabled: loading,
                                    }}
                                />
                            );
                        })}
                    </ul>
                )}
            </div>
        </section>
    );
});

// Edit Convention Modal Component
const EditConventionModal = memo(({ convention, onClose, onSave, loading, showMessage }) => {
    const [name, setName] = useState(convention.name);
    const [startDate, setStartDate] = useState(convention.startDate.split('T')[0]);
    const [endDate, setEndDate] = useState(convention.endDate.split('T')[0]);

    const handleSave = () => {
        if (!name.trim() || !startDate || !endDate) {
            showMessage("Convention name, start date, and end date are required.", 'info');
            return;
        }
        if (new Date(startDate) > new Date(endDate)) {
            showMessage("Start date cannot be after end date.", 'error');
            return;
        }
        onSave(convention.id, name, startDate, endDate);
    };

    return (
        <div className="dfwgv-modal-overlay fixed inset-0 flex items-center justify-center z-50 p-4">
            <div className="dfwgv-modal-panel bg-gray-800 rounded-lg shadow-xl p-6 max-w-md w-full border border-gray-700">
                <h2 className="text-2xl font-semibold text-gray-100 mb-4">Edit Convention</h2>
                <div className="flex flex-col gap-4 mb-4">
                    <label className="block text-sm font-medium text-gray-300">
                        Convention Name:
                        <input
                            type="text"
                            className="mt-1 w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 focus:ring-blue-500 focus:border-blue-500"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                        />
                    </label>
                    <label className="block text-sm font-medium text-gray-300">
                        Start Date:
                        <input
                            type="date"
                            id="startDate"
                            className="mt-1 w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 focus:ring-blue-500 focus:border-blue-500"
                            value={startDate}
                            onChange={(e) => setStartDate(e.target.value)}
                        />
                    </label>
                    <label className="block text-sm font-medium text-gray-300">
                        End Date:
                        <input
                            type="date"
                            id="endDate"
                            className="mt-1 w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 focus:ring-blue-500 focus:border-blue-500"
                            value={endDate}
                            onChange={(e) => setEndDate(e.target.value)}
                        />
                    </label>
                </div>
                <div className="flex justify-end space-x-3">
                    <button
                        onClick={handleSave}
                        className="dfwgv-btn dfwgv-btn-primary"
                        disabled={loading}
                    >
                        Save Changes
                    </button>
                    <button
                        onClick={onClose}
                        className="dfwgv-btn dfwgv-btn-secondary"
                        disabled={loading}
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    );
});


// Admin-only modal: pick a public DFWGV Planner event and mirror its hosted
// tables onto a convention, so the public library page can display them.
const SyncPlannerModal = memo(({ convention, onClose, onSync, onUnlink, syncBusy }) => {
    const [gamedays, setGamedays] = useState(null); // null = still loading
    const [loadError, setLoadError] = useState('');
    const [selectedId, setSelectedId] = useState(convention.plannerEvent?.gamedayId || '');

    useEffect(() => {
        let cancelled = false;
        fetchPlannerGamedays()
            .then(list => { if (!cancelled) setGamedays(list); })
            .catch(error => {
                console.error('[SyncPlanner] Failed to list Planner events:', error);
                if (!cancelled) setLoadError(error.message);
            });
        return () => { cancelled = true; };
    }, []);

    const selected = (gamedays || []).find(gd => gd.id === selectedId) || null;

    return (
        <div className="dfwgv-modal-overlay fixed inset-0 flex items-center justify-center z-50 p-4">
            <div className="dfwgv-modal-panel bg-gray-800 rounded-lg shadow-xl p-6 max-w-lg w-full border border-gray-700">
                <h2 className="text-xl font-semibold text-gray-100 mb-1">Link Planner event</h2>
                <p className="text-gray-300 text-sm mb-4">
                    Links a public Planner event to "{convention.name}". The public library page then
                    shows the event's hosted tables live — new tables appear automatically as hosts add them.
                </p>

                {convention.plannerEvent && (
                    <p className="text-gray-300 text-sm mb-4">
                        Currently linked: <span className="font-semibold text-gray-100">{convention.plannerEvent.title || convention.plannerEvent.gamedayId}</span>
                    </p>
                )}

                {loadError ? (
                    <p className="text-red-400 text-sm mb-4">Couldn't load Planner events: {loadError}</p>
                ) : gamedays === null ? (
                    <p className="text-gray-400 text-sm mb-4">Loading Planner events…</p>
                ) : gamedays.length === 0 ? (
                    <p className="text-gray-400 text-sm mb-4">No public, published Planner events found.</p>
                ) : (
                    <div className="dfwgv-modal-scroll mb-4" style={{ maxHeight: '260px' }}>
                        {gamedays.map(gd => (
                            <label key={gd.id} className="flex items-start gap-3 p-2 rounded cursor-pointer hover:bg-gray-700">
                                <input
                                    type="radio"
                                    name="plannerEvent"
                                    className="mt-1"
                                    checked={selectedId === gd.id}
                                    onChange={() => setSelectedId(gd.id)}
                                />
                                <span>
                                    <span className="text-gray-100 font-semibold block">{gd.title || gd.id}</span>
                                    <span className="text-gray-400 text-xs">
                                        {gd.startsAt ? new Date(gd.startsAt).toLocaleDateString() : 'Date TBD'}
                                        {gd.location ? ` • ${gd.location}` : ''}
                                    </span>
                                </span>
                            </label>
                        ))}
                    </div>
                )}

                <div className="flex flex-wrap justify-end gap-3">
                    {convention.plannerEvent && (
                        <button onClick={onUnlink} className="dfwgv-btn dfwgv-btn-danger" disabled={syncBusy}>
                            Unlink
                        </button>
                    )}
                    <button
                        onClick={() => selected && onSync(selected)}
                        className="dfwgv-btn dfwgv-btn-primary"
                        disabled={!selected || syncBusy}
                    >
                        {syncBusy ? 'Linking…' : 'Link event'}
                    </button>
                    <button onClick={onClose} className="dfwgv-btn dfwgv-btn-secondary" disabled={syncBusy}>
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
});

// New All Conventions Page Component
const AllConventionsPage = memo(({
    conventions, currentConvention, createConvention, deleteConvention, updateConvention,
    loading, showMessage, setCurrentConventionId, setEditingConvention, copyPublicLink,
    isAdmin, onSyncPlanner
}) => {
    const [newConventionName, setNewConventionName] = useState('');
    const [newConventionStartDate, setNewConventionStartDate] = useState('');
    const [newConventionEndDate, setNewConventionEndDate] = useState('');
    const [sortOrder, setSortOrder] = useState('desc'); // 'desc' or 'asc'

    const handleCreateConvention = () => {
        createConvention(newConventionName, newConventionStartDate, newConventionEndDate);
        setNewConventionName('');
        setNewConventionStartDate('');
        setNewConventionEndDate('');
    };

    const sortedConventions = useMemo(() => {
        if (!conventions) return [];
        return [...conventions].sort((a, b) => {
            const dateA = new Date(a.startDate).getTime();
            const dateB = new Date(b.startDate).getTime();
            return sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
        });
    }, [conventions, sortOrder]);

    const toggleSortOrder = () => {
        setSortOrder(currentOrder => (currentOrder === 'desc' ? 'asc' : 'desc'));
    };

    return (
        <section className="bg-gray-800 p-6 rounded-xl shadow-lg mb-8 w-full max-w-4xl border border-gray-700">
            <div className="flex justify-between items-center mb-4">
                <h2 className="text-2xl font-semibold text-gray-100 m-0">Conventions</h2>
                <button
                    onClick={toggleSortOrder}
                    className="dfwgv-btn dfwgv-btn-secondary dfwgv-btn-sm"
                >
                    Sort by Date: {sortOrder === 'desc' ? 'Newest First' : 'Oldest First'}
                </button>
            </div>
            <div className="mb-6">
                <h3 className="text-xl font-medium text-gray-300 mb-3">Create New Convention:</h3>
                <div className="flex flex-col gap-4 mb-4">
                    <input
                        type="text"
                        className="p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 placeholder-gray-400 focus:ring-blue-500 focus:border-blue-500"
                        value={newConventionName}
                        onChange={(e) => setNewConventionName(e.target.value)}
                        placeholder="Convention Name"
                    />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label htmlFor="startDate" className="block text-sm font-medium text-gray-300 mb-1">Start Date</label>
                            <input
                                type="date"
                                id="startDate"
                                className="w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 focus:ring-blue-500 focus:border-blue-500"
                                value={newConventionStartDate}
                                onChange={(e) => setNewConventionStartDate(e.target.value)}
                            />
                        </div>
                        <div>
                            <label htmlFor="endDate" className="block text-sm font-medium text-gray-300 mb-1">End Date</label>
                            <input
                                type="date"
                                id="endDate"
                                className="w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 focus:ring-blue-500 focus:border-blue-500"
                                value={newConventionEndDate}
                                onChange={(e) => setNewConventionEndDate(e.target.value)}
                            />
                        </div>
                    </div>
                    <button
                        onClick={handleCreateConvention}
                        className="dfwgv-btn dfwgv-btn-primary"
                        disabled={loading}
                    >
                        Create Convention
                    </button>
                </div>
            </div>

            <h3 className="text-xl font-medium text-gray-300 mb-3">Existing Conventions:</h3>
            <div className="scrollable-list bg-gray-700 p-3 border border-gray-600">
                {sortedConventions.length === 0 ? (
                    <p className="text-gray-400">No conventions created yet.</p>
                ) : (
                    <ul className="space-y-2">
                        {sortedConventions.map(conv => {
                            const isSelected = currentConvention?.id === conv.id;
                            return (
                                <li key={conv.id} className="flex flex-col sm:flex-row items-start sm:items-center justify-between bg-gray-900 p-3 rounded-md shadow-sm border border-gray-700">
                                    <div className="flex-grow">
                                        <span className="font-medium text-gray-100 block">
                                            {conv.name}
                                            {isSelected && <span className="dfwgv-pill ok ml-2">Selected</span>}
                                            {conv.plannerEvent && <span className="dfwgv-pill muted ml-2">🗓 {conv.plannerEvent.title || 'Planner event'}</span>}
                                        </span>
                                        <span className="text-sm text-gray-300">
                                            {new Date(conv.startDate).toLocaleDateString()} - {new Date(conv.endDate).toLocaleDateString()}
                                        </span>
                                    </div>
                                    <div className="flex flex-col sm:flex-row gap-2 mt-3 sm:mt-0">
                                        <button
                                            onClick={() => setCurrentConventionId(isSelected ? null : conv.id)}
                                            className={`dfwgv-btn ${isSelected ? 'dfwgv-btn-secondary' : 'dfwgv-btn-primary'}`}
                                        >
                                            {isSelected ? 'Deselect' : 'Select'}
                                        </button>
                                        <button
                                            onClick={() => copyPublicLink(conv)}
                                            className="dfwgv-btn dfwgv-btn-secondary"
                                            title="Copy a read-only link that shows this convention's games and live availability"
                                        >
                                            🔗 Public link
                                        </button>
                                        {isAdmin && (
                                            <button
                                                onClick={() => onSyncPlanner(conv)}
                                                className="dfwgv-btn dfwgv-btn-secondary"
                                                disabled={loading}
                                                title="Sync a DFWGV Planner event's hosted tables onto this convention's public page (admin only)"
                                            >
                                                🗓 Planner sync
                                            </button>
                                        )}
                                        <button
                                            onClick={() => setEditingConvention(conv)}
                                            className="dfwgv-btn dfwgv-btn-secondary"
                                            disabled={loading}
                                        >
                                            Edit
                                        </button>
                                        <button
                                            onClick={() => deleteConvention(conv)}
                                            className="dfwgv-btn dfwgv-btn-danger"
                                            disabled={loading}
                                        >
                                            Delete
                                        </button>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </section>
    );
});

// New Checked Out Games Page Component
const CheckedOutGamesPage = memo(({ currentConvention, toggleGameConventionCheckout, loading, showMessage, homeSearchInputRef, librarySearchInputRef, currentPage }) => {
    const checkedOutGames = useMemo(() => {
        if (!currentConvention?.games) return [];
        return currentConvention.games.filter(game => {
            if (!game || typeof game.id === 'undefined') {
                return false;
            }
            return game.isCheckedOutAtConvention;
        });
    }, [currentConvention]);

    const handleToggleAndFocus = async (game, conventionId) => {
        await toggleGameConventionCheckout(game, conventionId);
        if (currentPage === 'home' && homeSearchInputRef.current) {
            homeSearchInputRef.current.focus();
        } else if (currentPage === 'library' && librarySearchInputRef.current) {
            librarySearchInputRef.current.focus();
        }
    };

    return (
        <section className="bg-gray-800 p-6 rounded-xl shadow-lg mb-8 w-full max-w-4xl border border-gray-700">
            <h2 className="text-2xl font-semibold text-gray-100 mb-4">
                Checked Out Games
                {currentConvention ? <span className="ml-3 text-sm font-normal text-gray-300">{currentConvention.name}</span> : null}
            </h2>
            {!currentConvention ? (
                <p className="text-gray-400">Select a convention (use the chip in the top bar) to view its checked out games.</p>
            ) : checkedOutGames.length === 0 ? (
                <p className="text-gray-400">No games are currently checked out for this convention. 🎉</p>
            ) : (
                <div className="mt-4 scrollable-list bg-gray-700 p-3 border border-gray-600">
                    <ul className="space-y-3 list-none p-0 m-0">
                        {checkedOutGames.map(convGame => {
                            if (!convGame || typeof convGame.id === 'undefined') {
                                return null;
                            }
                            return (
                                <GameRow
                                    key={convGame.id}
                                    game={convGame}
                                    metaItems={[
                                        <><span className="star">★</span> {(typeof convGame?.averageRating === 'number') ? convGame.averageRating.toFixed(1) : 'N/A'}</>,
                                        `×${convGame.conventionCheckoutCount || 0} checkouts`,
                                    ]}
                                    pill={{ label: 'Checked out', tone: 'out' }}
                                    primary={{
                                        label: 'Check In',
                                        tone: 'primary',
                                        onClick: () => handleToggleAndFocus(convGame, currentConvention.id),
                                        disabled: loading,
                                    }}
                                />
                            );
                        })}
                    </ul>
                </div>
            )}
        </section>
    );
});

// Settings page: danger zone for the destructive clear-all operations,
// each gated behind a type-to-confirm modal instead of stacked confirm dialogs.
const SettingsPage = memo(({ performClearAllCheckoutData, performClearAllData, loading }) => {
    const [confirming, setConfirming] = useState(null); // null | 'checkouts' | 'all'

    return (
        <section className="bg-gray-800 p-6 rounded-xl shadow-lg mb-8 w-full max-w-4xl border border-gray-700 dfwgv-danger-zone">
            <h2 className="text-2xl font-semibold text-gray-100 mb-2">Settings</h2>
            <p className="text-gray-300 mb-4 text-sm">
                Danger zone. These actions affect the whole library and cannot be undone.
            </p>

            <div className="dfwgv-danger-item">
                <div className="info">
                    <b>Clear all checkout data</b>
                    <span>Resets every game and convention checkout count to zero. Games and conventions are kept.</span>
                </div>
                <button
                    onClick={() => setConfirming('checkouts')}
                    className="dfwgv-btn dfwgv-btn-danger"
                    disabled={loading}
                >
                    Clear checkout data
                </button>
            </div>

            <div className="dfwgv-danger-item">
                <div className="info">
                    <b>Delete all games</b>
                    <span>Permanently deletes every game and its checkout history. Conventions are kept.</span>
                </div>
                <button
                    onClick={() => setConfirming('all')}
                    className="dfwgv-btn dfwgv-btn-danger"
                    disabled={loading}
                >
                    Delete all games
                </button>
            </div>

            {confirming === 'checkouts' && (
                <TypeConfirmModal
                    title="Clear checkout data"
                    description="Every checkout count, on every game and every convention, will be reset to zero. This cannot be undone."
                    phrase="RESET"
                    loading={loading}
                    onClose={() => setConfirming(null)}
                    onConfirm={async () => { await performClearAllCheckoutData(); setConfirming(null); }}
                />
            )}

            {confirming === 'all' && (
                <TypeConfirmModal
                    title="Delete all games"
                    description="Every game and its full checkout history will be permanently deleted. This cannot be undone."
                    phrase="DELETE"
                    loading={loading}
                    onClose={() => setConfirming(null)}
                    onConfirm={async () => { await performClearAllData(); setConfirming(null); }}
                />
            )}
        </section>
    );
});


// Main App Component
const App = () => {
    // Get db and appId from FirebaseContext, currentUser and auth functions from AuthContext
    const { db, appId } = useContext(FirebaseContext);
    const { currentUser, loadingAuth, logout, login } = useContext(AuthContext); // Get login from AuthContext directly

    const [games, setGames] = useState([]); // All active games in the library
    const [removedGames, setRemovedGames] = useState([]); // All removed games in the library
    const [conventions, setConventions] = useState([]);
    const [currentConventionId, setCurrentConventionId] = useState(null); // Stores only the ID of the selected convention
    // NEW STATE FOR SELECTED CONVENTION OBJECT
    const [selectedConventionState, setSelectedConventionState] = useState(null);
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState('');
    const [messageType, setMessageType] = useState('info');
    const [confirmAction, setConfirmAction] = useState(null);
    const [currentPage, setCurrentPage] = useState('home'); // 'home', 'library', 'removed', 'allConventions', 'import', 'checkedOutGames'
    const [editingConvention, setEditingConvention] = useState(null); // State for convention being edited
    const [addingCustomGame, setAddingCustomGame] = useState(false); // State for adding custom game modal

    // Refs for search inputs
    const homeSearchInputRef = useRef(null);
    const librarySearchInputRef = useRef(null);

    // State for search terms, managed directly in App
    const [homeSearchTerm, setHomeSearchTerm] = useState('');
    const [searchTerm, setSearchTerm] = useState('');

    // Memoized map for quick game lookups by ID
    const gamesByIdMap = useMemo(() => {
        const map = new Map();
        games.forEach(game => map.set(game.id, game));
        return map;
    }, [games]); // Recompute only when 'games' array changes


    // Derive currentConvention object from currentConventionId and conventions list
    // This ensures currentConvention is always up-to-date with the latest data from Firestore
    useEffect(() => {
        const foundConvention = conventions.find(conv => conv.id === currentConventionId) || null;
        // console.log(`[App Effect] Updating selectedConventionState. Found: ${foundConvention?.name || 'None'}, ID: ${foundConvention?.id || 'N/A'}. Games: ${foundConvention?.games?.length || 0}`); // Removed for performance
        setSelectedConventionState(foundConvention);
    }, [conventions, currentConventionId]);

    // Use selectedConventionState as currentConvention throughout the app
    const currentConvention = selectedConventionState;


    // Function to show custom message box
    const showMessage = useCallback((msg, type = 'info', onConfirm = null) => {
        // console.log(`[showMessage] Displaying: ${msg} (Type: ${type})`); // Removed for performance
        setMessage(msg);
        setMessageType(type);
        setConfirmAction(() => onConfirm);
    }, []);

    const closeMessage = useCallback(() => {
        // console.log('[showMessage] Closing message box.'); // Removed for performance
        setMessage('');
        setMessageType('info');
        setConfirmAction(null);
    }, []);

    // Non-blocking toasts for success/info feedback (modals stay for errors and confirmations)
    const [toasts, setToasts] = useState([]);
    const showToast = useCallback((text) => {
        const id = `${Date.now()}-${Math.random()}`;
        setToasts(prev => [...prev, { id, text }]);
        setTimeout(() => {
            setToasts(prev => prev.filter(t => t.id !== id));
        }, 4000);
    }, []);

    // Import progress + per-username results, surfaced on the Import page
    const [importStatus, setImportStatus] = useState('');
    const [importResults, setImportResults] = useState([]);

    // Overall admin: sees the Planner-sync controls (client-side gating by login email)
    const isAdmin = !!currentUser?.email && ADMIN_EMAILS.includes(currentUser.email.toLowerCase());

    // Planner sync state: which convention's sync modal is open, and whether a sync is running
    const [syncingConventionId, setSyncingConventionId] = useState(null);
    const [plannerSyncBusy, setPlannerSyncBusy] = useState(false);

    // Copy a convention's public read-only link (?con=<id>) to the clipboard
    const copyPublicLink = useCallback(async (conv) => {
        if (!conv) return;
        const url = `${window.location.origin}${window.location.pathname}?con=${conv.id}`;
        try {
            await navigator.clipboard.writeText(url);
            showToast(`Public link for "${conv.name}" copied.`);
        } catch (error) {
            // Clipboard access can be blocked; fall back to showing the link for manual copy
            showMessage(`Public link for "${conv.name}": ${url}`, 'info');
        }
    }, [showToast, showMessage]);

    // Function to focus the appropriate search input based on the current page and clear its value
    const focusSearchInput = useCallback(() => {
        if (currentPage === 'home' && homeSearchInputRef.current) {
            homeSearchInputRef.current.focus();
        } else if (currentPage === 'library' && librarySearchInputRef.current) {
            librarySearchInputRef.current.focus();
        }
    }, [currentPage]);


    // Fetch games from BGG API - Modified to exclude expansions.
    // Returns { games, error } so the caller can report per-username results.
    const fetchBggCollection = useCallback(async (username) => {
        try {
            // BGG's XML API now requires an auth token, so requests go through the
            // dfwgv-bgg-proxy Cloudflare Worker (holds the token, excludes expansions by default).
            const url = `https://dfwgv-bgg-proxy.joemsprague.workers.dev/api/bgg-collection?username=${encodeURIComponent(username)}`;
            let response = await retryFetch(url, {}, 5, 1000);
            // BGG queues large collection requests and answers 202 until the export is ready.
            for (let attempt = 0; response.status === 202 && attempt < 5; attempt++) {
                setImportStatus(`BGG is preparing ${username}'s collection, waiting…`);
                await new Promise(res => setTimeout(res, 3000));
                response = await retryFetch(url, {}, 5, 1000);
            }
            if (!response.ok) {
                throw new Error(`BGG returned HTTP ${response.status}`);
            }
            const text = await response.text();
            if (text.includes('<errors>')) {
                const errorMessage = text.match(/<message>([^<]*)<\/message>/)?.[1] || 'BGG reported an error';
                throw new Error(`${errorMessage} — check the username`);
            }
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(text, "text/xml");
            const items = xmlDoc.getElementsByTagName('item');

            const newGames = [];
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const bggId = item.getAttribute('objectid');
                const collId = item.getAttribute('collid'); // Get the unique collection item ID
                const name = item.getElementsByTagName('name')[0]?.textContent || 'Unknown Game';
                const thumbnail = item.getElementsByTagName('thumbnail')[0]?.textContent || '';
                const image = item.getElementsByTagName('image')[0]?.textContent || '';
                // Since we are excluding expansions, isExpansion will always be false for imported games
                const isExpansion = false;
                const baseGameBggId = null; // No need for baseGameBggId if expansions are excluded

                const statsElement = item.getElementsByTagName('stats')[0];
                const minPlayers = statsElement?.getAttribute('minplayers') || 0;
                const maxPlayers = statsElement?.getAttribute('maxplayers') || 0;
                const playingTime = statsElement?.getAttribute('playingtime') || 0;
                // Corrected: Access 'rating' (singular) tag, then 'average', then 'value' attribute
                const averageRatingElement = statsElement?.getElementsByTagName('rating')[0]?.getElementsByTagName('average')[0];
                const averageRating = parseFloat(averageRatingElement?.getAttribute('value'));

                // console.log(`[BGG Import Debug] Game: ${name}, BGG ID: ${bggId}, Coll ID: ${collId}, Parsed Avg Rating: ${averageRating}`); // Removed for performance


                newGames.push({
                    id: collId, // Use collId as the unique ID for this instance
                    bggId,
                    name,
                    thumbnail,
                    image,
                    minPlayers: parseInt(minPlayers),
                    maxPlayers: parseInt(maxPlayers),
                    playingTime: parseInt(playingTime),
                    averageRating: isNaN(averageRating) ? null : averageRating, // Store null if NaN
                    ownerName: username,
                    ownerId: currentUser?.uid, // Use currentUser.uid
                    checkoutCount: 0,
                    isCheckedOut: false,
                    lastCheckedOutBy: '',
                    lastCheckedOutDate: null,
                    lastCheckedInDate: null,
                    isExpansion,
                    baseGameBggId,
                    isRemoved: false,
                });
                // console.log(`[BGG Import Debug] Game: ${name}, BGG ID: ${bggId}, Coll ID: ${collId}, Subtype: boardgame (excluded expansions), isExpansion: ${isExpansion}`); // Removed for performance
            }
            // console.log(`[BGG Import] Fetched ${newGames.length} games for ${username}.`); // Removed for performance
            return { games: newGames, error: null };
        } catch (error) {
            console.error(`[BGG Import] Error fetching BGG collection for ${username}:`, error);
            return { games: [], error: error.message };
        }
    }, [currentUser]); // Dependency on currentUser

    // Import games from BGG and save/update to Firestore
    const importGames = useCallback(async (owner1BggUsername, owner2BggUsername) => {
        if (!db || !currentUser) { // Check currentUser
            console.warn("[ImportGames] Firebase not initialized or currentUser missing.");
            showMessage("Please log in to import games.", 'error');
            return;
        }
        setLoading(true);
        setImportResults([]);
        const results = [];

        try {
            // Function to process games for a single owner
            const processOwnerGames = async (username) => {
                setImportStatus(`Fetching collection for ${username}…`);
                const { games: importedGames, error } = await fetchBggCollection(username);

                if (error) {
                    return { username, fetched: 0, added: 0, updated: 0, error };
                }
                if (importedGames.length === 0) {
                    return { username, fetched: 0, added: 0, updated: 0, error: 'No games found in this collection' };
                }

                setImportStatus(`Saving ${importedGames.length} games for ${username}…`);

                // Create a combined map of existing active and removed games for efficient lookup
                // Key is now the unique collId
                const allExistingGamesMap = new Map();
                games.forEach(game => { // Active games
                    allExistingGamesMap.set(game.id, { id: game.id, data: game });
                });
                removedGames.forEach(game => { // Removed games
                    allExistingGamesMap.set(game.id, { id: game.id, data: game });
                });

                let addedCount = 0;
                let updatedCount = 0;

                const gamesCollectionRef = collection(db, `artifacts/${appId}/public/data/games`);

                const writePromises = importedGames.map(async (game) => {
                    const gameDocId = game.id; // Use the collId as the Firestore document ID
                    const existingGameEntry = allExistingGamesMap.get(gameDocId);

                    if (existingGameEntry) {
                        const existingData = existingGameEntry.data;
                        let needsUpdate = false;
                        const updateData = {};

                        // Compare fields that might change from BGG, but preserve checkout data and isRemoved status
                        if (existingData.name !== game.name) { updateData.name = game.name; needsUpdate = true; }
                        if (existingData.thumbnail !== game.thumbnail) { updateData.thumbnail = game.thumbnail; needsUpdate = true; }
                        if (existingData.image !== game.image) { updateData.image = game.image; needsUpdate = true; }
                        if (existingData.minPlayers !== game.minPlayers) { updateData.minPlayers = game.minPlayers; needsUpdate = true; }
                        if (existingData.maxPlayers !== game.maxPlayers) { updateData.maxPlayers = game.maxPlayers; needsUpdate = true; }
                        if (existingData.playingTime !== game.playingTime) { updateData.playingTime = game.playingTime; needsUpdate = true; }
                        if (existingData.averageRating !== game.averageRating) { updateData.averageRating = game.averageRating; needsUpdate = true; }
                        
                        // If a game was previously removed but is now being imported again, re-add it (set isRemoved to false)
                        if (existingData.isRemoved) {
                            updateData.isRemoved = false;
                            needsUpdate = true;
                        }

                        if (needsUpdate) {
                            // console.log(`[ImportGames] Updating existing game: ${game.name} (${game.ownerName})`); // Removed for performance
                            await updateDoc(doc(gamesCollectionRef, existingGameEntry.id), updateData);
                            updatedCount++;
                        }
                    } else {
                        // console.log(`[ImportGames] Adding new game: ${game.name} (${game.ownerName})`); // Removed for performance
                        await setDoc(doc(gamesCollectionRef, gameDocId), { ...game, isRemoved: false });
                        addedCount++;
                    }
                });

                await Promise.all(writePromises);
                return { username, fetched: importedGames.length, added: addedCount, updated: updatedCount, error: null };
            };

            for (const username of [owner1BggUsername, owner2BggUsername]) {
                if (username) {
                    results.push(await processOwnerGames(username));
                }
            }

            setImportResults(results);

            const failures = results.filter(r => r.error);
            const totalAdded = results.reduce((sum, r) => sum + r.added, 0);
            const totalUpdated = results.reduce((sum, r) => sum + r.updated, 0);

            if (failures.length > 0) {
                showMessage(
                    failures.map(f => `${f.username}: ${f.error}`).join('\n'),
                    'error'
                );
            } else if (totalAdded === 0 && totalUpdated === 0) {
                showToast('Import finished — everything was already up to date.');
            } else {
                showToast(`Import complete: ${totalAdded} added, ${totalUpdated} updated.`);
            }

        } catch (error) {
            console.error("[ImportGames] Error during import process:", error);
            showMessage(`Error importing games: ${error.message}. Please try again.`, 'error');
        } finally {
            setImportStatus('');
            setLoading(false);
        }
    }, [db, currentUser, fetchBggCollection, showMessage, showToast, appId, games, removedGames]); // eslint-disable-line react-hooks/exhaustive-deps

    // Link a Planner event to a convention. Only lightweight metadata is stored —
    // the public page subscribes to the Planner's tables directly, so new tables
    // appear there automatically without any re-sync.
    const linkPlannerEvent = useCallback(async (conventionId, gameday) => {
        if (!db || !currentUser) return;
        setPlannerSyncBusy(true);
        try {
            const conventionRef = doc(db, `artifacts/${appId}/public/data/conventions`, conventionId);
            await updateDoc(conventionRef, {
                plannerEvent: {
                    gamedayId: gameday.id,
                    title: gameday.title || '',
                    location: gameday.location || '',
                    startsAt: gameday.startsAt || null,
                    endsAt: gameday.endsAt || null,
                    linkedAt: new Date().toISOString(),
                },
            });
            showToast(`Linked "${gameday.title || 'Planner event'}" — its tables now show live on the public page.`);
            setSyncingConventionId(null);
        } catch (error) {
            console.error('[SyncPlanner] Link failed:', error);
            showMessage(`Planner link failed: ${error.message}`, 'error');
        } finally {
            setPlannerSyncBusy(false);
        }
    }, [db, currentUser, appId, showToast, showMessage]);

    const unlinkPlannerEvent = useCallback(async (conventionId) => {
        if (!db || !currentUser) return;
        setPlannerSyncBusy(true);
        try {
            const conventionRef = doc(db, `artifacts/${appId}/public/data/conventions`, conventionId);
            await updateDoc(conventionRef, { plannerEvent: deleteField() });
            showToast('Planner event unlinked.');
            setSyncingConventionId(null);
        } catch (error) {
            console.error('[SyncPlanner] Unlink failed:', error);
            showMessage(`Unlink failed: ${error.message}`, 'error');
        } finally {
            setPlannerSyncBusy(false);
        }
    }, [db, currentUser, appId, showToast, showMessage]);

    // Listen for real-time updates to games and conventions
    useEffect(() => {
        if (!db || !currentUser) { // Check currentUser
            console.warn("[useEffect] Firebase not initialized or currentUser missing for data listeners.");
            return;
        }
        // console.log("[useEffect] Setting up Firestore listeners."); // Removed for performance

        // Listen for games
        const gamesCollectionRef = collection(db, `artifacts/${appId}/public/data/games`);
        const unsubscribeGames = onSnapshot(gamesCollectionRef, (snapshot) => {
            const fetchedGames = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            // console.log(`[Firestore Games] RAW fetchedGames (${fetchedGames.length} docs):`, fetchedGames.map(g => ({id: g.id, name: g.name, isRemoved: g.isRemoved})).slice(0, 5)); // Removed for performance
            const activeGames = fetchedGames.filter(game => {
                // Ensure game object and its properties are valid before filtering
                if (!game || typeof game.isRemoved === 'undefined') {
                    // console.warn("[Firestore Filter] Skipping malformed game in active filter:", game); // Removed for performance
                    return false; // Exclude malformed entries from active games
                }
                return !game.isRemoved;
            });
            const removedGamesData = fetchedGames.filter(game => {
                if (!game || typeof game.isRemoved === 'undefined') {
                    // console.warn("[Firestore Filter] Skipping malformed game in removed filter:", game); // Removed for performance
                    return false; // Exclude malformed entries from removed games
                }
                return game.isRemoved;
            });
            // console.log(`[Firestore Games] Active Games after filter: ${activeGames.length}`); // Removed for performance
            // console.log(`[Firestore Games] Removed Games after filter: ${removedGamesData.length}`); // Removed for performance
            setGames(activeGames);
            setRemovedGames(removedGamesData);
        }, (error) => {
            console.error("[Firestore] Error fetching games:", error);
            showMessage("Failed to load games.", 'error');
        });

        // Listen for conventions
        const conventionsCollectionRef = collection(db, `artifacts/${appId}/public/data/conventions`);
        const unsubscribeConventions = onSnapshot(conventionsCollectionRef, (snapshot) => {
            const fetchedConventions = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                // Ensure games array is always present, defaulting to empty if not found
                games: doc.data().games || []
            }));
            // console.log(`[Firestore] Conventions snapshot received: ${fetchedConventions.length} documents. Sample:`, fetchedConventions.slice(0, 2)); // Removed for performance
            
            // Find the current convention in the *newly fetched* list
            const updatedCurrentConvData = fetchedConventions.find(conv => conv.id === currentConventionId);
            if (updatedCurrentConvData) {
                // console.log(`[Firestore] Current selected convention (${updatedCurrentConvData.name}) games array after snapshot: ${updatedCurrentConvData.games?.length || 0} games. Sample IDs:`, updatedCurrentConvData.games?.slice(0, 5).map(g => g.id)); // Removed for performance
            } else if (currentConventionId) {
                // console.log(`[Firestore] Current Convention (ID: ${currentConventionId}) not found in latest snapshot.`); // Removed for performance
            }

            setConventions(fetchedConventions);
            // If the currently selected convention is no longer in the fetched list (e.g., deleted), deselect it.
            if (currentConventionId && !fetchedConventions.some(conv => conv.id === currentConventionId)) {
                setCurrentConventionId(null);
                // console.log(`[Firestore] Current convention (ID: ${currentConventionId}) no longer found in fetched data. Deselecting.`); // Removed for performance
            }
        }, (error) => {
            console.error("[Firestore] Error fetching conventions:", error);
            showMessage("Failed to load conventions.", 'error');
        });

        return () => {
            // console.log("[useEffect] Cleaning up Firestore listeners."); // Removed for performance
            unsubscribeGames();
            unsubscribeConventions();
        };
    }, [db, currentUser, showMessage, appId, currentConventionId]); // Dependency on currentUser

    // Create a new convention (now takes arguments from AllConventionsPage)
    const createConvention = useCallback(async (name, startDate, endDate) => {
        if (!db || !currentUser) { // Check currentUser
            console.warn("[CreateConvention] Firebase not initialized or currentUser missing.");
            showMessage("Please log in to create conventions.", 'error');
            return;
        }
        if (!name.trim() || !startDate || !endDate) {
            showMessage("Convention name, start date, and end date are required.", 'info');
            return;
        }
        if (new Date(startDate) > new Date(endDate)) {
            showMessage("Start date cannot be after end date.", 'error');
            return;
        }

        setLoading(true);
        // console.log(`[CreateConvention] Attempting to create convention: ${name}`); // Removed for performance
        try {
            const conventionsCollectionRef = collection(db, `artifacts/${appId}/public/data/conventions`);
            await addDoc(conventionsCollectionRef, {
                name: name,
                startDate: new Date(startDate + 'T12:00:00').toISOString(),
                endDate: new Date(endDate + 'T12:00:00').toISOString(),
                games: [], // Initialize with an empty array of games
                ownerId: currentUser.uid, // Use currentUser.uid
            });
            // console.log(`[CreateConvention] Convention "${name}" created successfully!`, 'info'); // Removed for performance
            showToast(`Convention "${name}" created.`);
        }
        catch (error) {
            console.error("[CreateConvention] Error creating convention:", error);
            showMessage("Error creating convention. Please try again.", 'error');
        } finally {
            setLoading(false);
        }
    }, [db, currentUser, showMessage, showToast, appId]);

    // Update an existing convention
    const updateConvention = useCallback(async (conventionId, name, startDate, endDate) => {
        if (!db || !currentUser) { // Check currentUser
            console.warn("[UpdateConvention] Firebase not initialized or currentUser missing.");
            showMessage("Please log in to update conventions.", 'error');
            return;
        }
        if (!name.trim() || !startDate || !endDate) {
            showMessage("Convention name, start date, and end date are required.", 'info');
            return;
        }
        if (new Date(startDate) > new Date(endDate)) {
            showMessage("Start date cannot be after end date.", 'error');
            return;
        }

        setLoading(true);
        // console.log(`[UpdateConvention] Attempting to update convention: ${name} (ID: ${conventionId})`); // Removed for performance
        try {
            const conventionRef = doc(db, `artifacts/${appId}/public/data/conventions`, conventionId);
            await updateDoc(conventionRef, {
                name: name,
                startDate: new Date(startDate + 'T12:00:00').toISOString(),
                endDate: new Date(endDate + 'T12:00:00').toISOString(),
            });
            // console.log(`[UpdateConvention] Convention "${name}" updated successfully!`, 'info'); // Removed for performance
            showToast(`Convention "${name}" updated.`);
            setEditingConvention(null); // Close the edit modal
        } catch (error) {
            console.error("[UpdateConvention] Error updating convention:", error);
            showMessage("Error updating convention. Please try again.", 'error');
        } finally {
            setLoading(false);
        }
    }, [db, currentUser, showMessage, showToast, appId]);

    // Delete a convention with double confirmation
    const deleteConvention = useCallback(async (conventionToDelete) => {
        if (!db || !currentUser) { // Check currentUser
            console.warn("[DeleteConvention] Firebase not initialized or currentUser missing.");
            showMessage("Please log in to delete conventions.", 'error');
            return;
        }
        // console.log(`[DeleteConvention] Initiating double confirmation for deleting: ${conventionToDelete.name}`); // Removed for performance
        showMessage(
            `Are you sure you want to delete "${conventionToDelete.name}"? This action is irreversible.`,
            'confirm',
            () => {
                showMessage(
                    `Deleting "${conventionToDelete.name}" is permanent. Are you absolutely sure?`,
                    'confirm',
                    async () => {
                        setLoading(true);
                        // console.log(`[DeleteConvention] Confirmed deletion of: ${conventionToDelete.name}`); // Removed for performance
                        try {
                            const conventionRef = doc(db, `artifacts/${appId}/public/data/conventions`, conventionToDelete.id);
                            await deleteDoc(conventionRef);
                            // The onSnapshot listener will handle updating 'conventions' state and deselecting currentConvention
                            // console.log(`[DeleteConvention] Convention "${conventionToDelete.name}" deleted from Firestore.`); // Removed for performance
                            showToast(`Convention "${conventionToDelete.name}" deleted.`);
                            // If the deleted convention was the currently selected one, deselect it.
                            if (currentConventionId === conventionToDelete.id) {
                                setCurrentConventionId(null);
                            }
                        } catch (error) {
                            console.error("[DeleteConvention] Error deleting convention:", error);
                            showMessage("Error deleting convention. Please try again.", 'error');
                        } finally {
                            setLoading(false);
                        }
                    }
                );
            }
        );
    }, [db, currentUser, showMessage, showToast, currentConventionId, appId]);

    // Add/Remove game from current convention
    const toggleGameForConvention = useCallback(async (game, conventionId) => { // Now accepts conventionId
        // console.log(`[toggleGameForConvention] Button clicked for game: ${game.name}, Convention ID: ${conventionId}`); // Removed for performance
        if (!db || !currentUser) { // Check currentUser
            console.warn("[ToggleGameForConvention] Firebase not initialized or currentUser missing.");
            showMessage("Please log in to manage convention games.", 'error');
            return;
        }
        
        // NEW: Check if conventionId is missing and show specific message
        if (!conventionId) {
            showMessage("Please select a convention first — use the convention chip in the top bar.", 'info');
            return;
        }

        // Find the currentConvention object from the conventions state, not just currentConventionId
        const targetConvention = conventions.find(conv => conv.id === conventionId);
        if (!targetConvention) {
            showMessage("Selected convention not found. Please refresh or select another.", 'error');
            return;
        }

        const isGameInConvention = targetConvention?.games?.some(g => g.id === game.id);

        const performUpdate = async () => {
            setLoading(true);
            try {
                // Use the games array from the currentConvention state directly
                const currentGamesInConvention = targetConvention.games || [];
                // console.log(`[toggleGameForConvention] Before update, currentGamesInConvention length: ${currentGamesInConvention.length}`, currentGamesInConvention.map(g => g.id)); // Removed for performance
                
                const gameInfoForConvention = {
                    id: game.id, // Use the unique collId
                    bggId: game.bggId,
                    name: game.name,
                    ownerName: game.ownerName,
                    thumbnail: game.thumbnail,
                    minPlayers: game.minPlayers, // Persist player count
                    maxPlayers: game.maxPlayers, // Persist player count
                    playingTime: game.playingTime, // Persist play time
                    averageRating: game.averageRating, // Persist average rating
                    conventionCheckoutCount: 0, // New: Convention-specific checkout count
                    isCheckedOutAtConvention: false, // New: Convention-specific checkout status
                    conventionCheckoutTimes: []
                };

                let updatedGames;
                let successMessage;

                if (isGameInConvention) {
                    updatedGames = currentGamesInConvention.filter(g => g.id !== game.id);
                    successMessage = `"${game.name}" removed from "${targetConvention.name}".`;

                    // When a game is removed from a convention, update its global status to 'Available'
                    // This logic might need refinement if a game can be checked out globally and also be in a convention.
                    // For now, it sets global status to available if it was checked out.
                    const mainGameRef = doc(db, `artifacts/${appId}/public/data/games`, game.id);
                    const mainGameDoc = await getDoc(mainGameRef);
                    if (mainGameDoc.exists() && mainGameDoc.data().isCheckedOut) {
                        // console.log(`[ToggleGameForConvention] Game ${game.name} was checked out globally. Setting to Available.`); // Removed for performance
                        await updateDoc(mainGameRef, {
                            isCheckedOut: false,
                            lastCheckedInDate: new Date().toISOString(),
                            lastCheckedOutBy: '', // Clear who checked it out
                        });
                    }

                } else {
                    updatedGames = [...currentGamesInConvention, gameInfoForConvention];
                    successMessage = `"${game.name}" added to "${targetConvention.name}".`;
                }

                // console.log(`[toggleGameForConvention] After calculation, updatedGames length: ${updatedGames.length}`, updatedGames.map(g => g.id)); // Removed for performance
                const conventionRef = doc(db, `artifacts/${appId}/public/data/conventions`, conventionId);
                await updateDoc(conventionRef, { games: updatedGames });
                // console.log("[ToggleGameForConvention] Convention document updated in Firestore."); // Removed for performance
                showToast(successMessage);
            } catch (error) {
                console.error("[ToggleGameForConvention] Error toggling game for convention:", error);
                showMessage("Error updating convention games. Please try again.", 'error');
            } finally {
                setLoading(false);
                focusSearchInput(); // Focus search input after operation
            }
        };

        // Show confirmation before removal if the game is already in the convention
        if (isGameInConvention) {
            showMessage(
                `Are you sure you want to remove "${game.name}" from "${targetConvention.name}"?`,
                'confirm',
                async () => {
                    await performUpdate();
                    closeMessage(); // Explicitly close the message box after update
                }
            );
        } else {
            // If adding, no confirmation needed
            performUpdate();
        }

    }, [db, currentUser, showMessage, showToast, closeMessage, appId, conventions, games, focusSearchInput]); // eslint-disable-line react-hooks/exhaustive-deps

    // Toggle checkout for a game specifically within a convention
    const toggleGameConventionCheckout = useCallback(async (gameInConvention, conventionId) => {
        // console.log(`[toggleGameConventionCheckout] Button clicked for game: ${gameInConvention.name}, Convention ID: ${conventionId}`); // Removed for performance
        if (!db || !currentUser || !conventionId) { // Check currentUser
            console.warn("[ToggleGameConventionCheckout] Firebase not initialized or convention not selected.");
            showMessage("Please log in and select a convention.", 'error');
            return;
        }
        setLoading(true);
        // console.log(`[ToggleGameConventionCheckout] Toggling checkout for ${gameInConvention.name} in convention ${conventionId}`); // Removed for performance
        try {
            // Use the games array from the currentConvention state directly
            const targetConvention = conventions.find(conv => conv.id === conventionId);
            if (!targetConvention) {
                showMessage("Selected convention not found. Please refresh or select another.", 'error');
                setLoading(false);
                return;
            }
            const currentGames = targetConvention.games || [];
            // console.log(`[toggleGameConventionCheckout] Before update, currentGames length: ${currentGames.length}`, currentGames.map(g => g.id)); // Removed for performance
            const gameIndex = currentGames.findIndex(g => g.id === gameInConvention.id);

            if (gameIndex === -1) {
                console.error("[ToggleGameConventionCheckout] Game not found in this convention's list.");
                showMessage("Game not found in this convention.", 'error');
                setLoading(false);
                return;
            }

            const newCheckedOutStatus = !gameInConvention.isCheckedOutAtConvention;
            const newConventionCheckoutCount = newCheckedOutStatus ? (gameInConvention.conventionCheckoutCount || 0) + 1 : gameInConvention.conventionCheckoutCount;

            // Update the game in the convention's array
            const updatedGamesInConvention = currentGames.map(g => {
                if (g.id !== gameInConvention.id) return g;
                const times = Array.isArray(g.conventionCheckoutTimes) ? g.conventionCheckoutTimes.slice() : [];
                if (newCheckedOutStatus) { times.push(new Date().toISOString()); }
                return { ...g, isCheckedOutAtConvention: newCheckedOutStatus, conventionCheckoutCount: newConventionCheckoutCount, conventionCheckoutTimes: times };
            });
            // console.log(`[toggleGameConventionCheckout] After calculation, updatedGamesInConvention length: ${updatedGamesInConvention.length}`, updatedGamesInConvention.map(g => g.id)); // Removed for performance
            // console.log(`[ToggleGameConventionCheckout] Updating convention document for ${gameInConvention.name}. New status: ${newCheckedOutStatus}`); // Removed for performance
            const conventionRef = doc(db, `artifacts/${appId}/public/data/conventions`, conventionId);
            await updateDoc(conventionRef, { games: updatedGamesInConvention });

            // ALSO update the overall checkout count on the main game document
            const gameRef = doc(db, `artifacts/${appId}/public/data/games`, gameInConvention.id);
            const gameDocSnapshot = await getDoc(gameRef);
            if (gameDocSnapshot.exists()) {
                const currentOverallCheckoutCount = gameDocSnapshot.data().checkoutCount || 0;
                const newOverallCheckoutCount = newCheckedOutStatus ? currentOverallCheckoutCount + 1 : currentOverallCheckoutCount;
                // console.log(`[ToggleGameConventionCheckout] Updating overall game document for ${gameInConvention.name}. New overall count: ${newOverallCheckoutCount}`); // Removed for performance
                await updateDoc(gameRef, {
                    checkoutCount: newOverallCheckoutCount,
                    isCheckedOut: newCheckedOutStatus, // Keep overall status in sync
                    lastCheckedOutDate: newCheckedOutStatus ? new Date().toISOString() : gameDocSnapshot.data().lastCheckedOutDate,
                    lastCheckedInDate: !newCheckedOutStatus ? new Date().toISOString() : gameDocSnapshot.data().lastCheckedInDate,
                });
            } else {
                console.warn(`[ToggleGameConventionCheckout] Main game document for ${gameInConvention.name} not found, overall checkout count not updated.`);
            }

            // Removed showMessage for this action as per user request
            // showMessage(`${gameInConvention.name} (${gameInConvention.ownerName}) ${newCheckedOutStatus ? 'checked out' : 'checked in'} for ${currentConvention?.name || 'the convention'}.`, 'info');
        } catch (error) {
            console.error("[ToggleGameConventionCheckout] Error toggling game convention checkout:", error);
            showMessage("Error updating game checkout status for convention. Please try again.", 'error');
        } finally {
            setLoading(false);
            focusSearchInput(); // Focus search input after operation
        }
    }, [db, currentUser, showMessage, appId, conventions, focusSearchInput]); // currentConvention changed to conventions

    // Export current convention games to CSV
    const exportConventionGamesToCsv = useCallback(async () => {
        if (!db || !currentConvention || !currentConvention.games || currentConvention.games.length === 0) {
            showMessage("No convention selected or no games in the current convention to export.", 'info');
            return;
        }
        if (!currentUser) { // Check currentUser
            showMessage("Please log in to export data.", 'error');
            return;
        }

        setLoading(true);
        // console.log(`[ExportCSV] Starting CSV export for convention: ${currentConvention.name}`); // Removed for performance
        try {
            // Use the locally available 'games' and 'removedGames' states for data
            const allAvailableGamesMap = new Map();
            games.forEach(game => allAvailableGamesMap.set(game.id, game));
            removedGames.forEach(game => allAvailableGamesMap.set(game.id, game));

            const detailedGames = currentConvention.games.map((convGame) => {
                const fullGameData = allAvailableGamesMap.get(convGame.id);

                return {
                    name: convGame.name,
                    ownerName: convGame.ownerName,
                    bggId: convGame.bggId,
                    isConventionCheckedOut: convGame.isCheckedOutAtConvention, // Use convention-specific status
                    conventionCheckoutCount: convGame.conventionCheckoutCount, // Use convention-specific count
                    overallCheckoutCount: fullGameData?.checkoutCount || 0, // Include overall count for reference
                    isRemoved: fullGameData ? fullGameData.isRemoved : true // Flag if it's removed from main library (or not found)
                };
            }).filter(Boolean); // Filter out any undefined entries if a game somehow wasn't found

            const headers = ["Game Name", "Owner", "BGG ID", "Convention Checkout Status", "Convention Checkouts", "Overall Checkouts", "Removed from Library"];
            const rows = detailedGames.map(game => [
                `"${game.name.replace(/"/g, '""')}"`,
                `"${game.ownerName.replace(/"/g, '""')}"`,
                game.bggId,
                game.isConventionCheckedOut ? "Checked Out" : "Available",
                game.conventionCheckoutCount,
                game.overallCheckoutCount,
                game.isRemoved ? "Yes" : "No",
            ]);

            const csvContent = [
                headers.join(','),
                ...rows.map(row => row.join(','))
            ].join('\n');

            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            if (link.download !== undefined) {
                const url = URL.createObjectURL(blob);
                link.setAttribute('href', url);
                link.setAttribute('download', `${currentConvention.name.replace(/\s/g, '_')}_Games.csv`);
                link.style.visibility = 'hidden';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                // console.log("[ExportCSV] CSV download initiated."); // Removed for performance
                showToast("CSV exported.");
            } else {
                console.warn("[ExportCSV] Browser does not support direct download.");
                showMessage("Your browser does not support downloading files directly. Please copy the content manually.", 'error');
            }
        } catch (error) {
            console.error("[ExportCSV] Error exporting CSV:", error);
            showMessage("Error exporting CSV. Please try again.", 'error');
        } finally {
            setLoading(false);
        }
    }, [db, currentConvention, showMessage, showToast, appId, games, removedGames, currentUser]); // eslint-disable-line react-hooks/exhaustive-deps

    // Remove game from overall library (soft delete)
    const removeGameFromLibrary = useCallback(async (gameToRemove) => {
        if (!db || !currentUser) { // Check currentUser
            console.warn("[RemoveGame] Firebase not initialized or currentUser missing.");
            showMessage("Please log in to remove games.", 'error');
            return;
        }
        setLoading(true);
        // console.log(`[RemoveGame] Initiating soft delete for game: ${gameToRemove.name}`); // Removed for performance
        try {
            // Soft delete: Set isRemoved to true
            const gameRef = doc(db, `artifacts/${appId}/public/data/games`, gameToRemove.id);
            await updateDoc(gameRef, { isRemoved: true });

            showToast(`"${gameToRemove.name}" moved to Removed games. Its history is preserved.`);
        } catch (error) {
            console.error("[RemoveGame] Error removing game from library:", error);
            showMessage("Error removing game from library. Please try again.", 'error');
        } finally {
            setLoading(false);
            focusSearchInput(); // Focus search input after operation
        }
    }, [db, currentUser, showMessage, showToast, appId, focusSearchInput]);

    // Re-add game to overall library (undo soft delete)
    const reAddGameToLibrary = useCallback(async (gameToReAdd) => {
        if (!db || !currentUser) { // Check currentUser
            console.warn("[ReAddGame] Firebase not initialized or currentUser missing.");
            showMessage("Please log in to re-add games.", 'error');
            return;
        }
        setLoading(true);
        // console.log(`[ReAddGame] Initiating re-add for game: ${gameToReAdd.name}`); // Removed for performance
        try {
            const gameRef = doc(db, `artifacts/${appId}/public/data/games`, gameToReAdd.id);
            await updateDoc(gameRef, { isRemoved: false });

            showToast(`"${gameToReAdd.name}" re-added to the library.`);
        } catch (error) {
            console.error("Error re-adding game to library:", error);
            showMessage("Error re-adding game to library. Please try again.", 'error');
        } finally {
            setLoading(false);
            focusSearchInput(); // Focus search input after operation
        }
    }, [db, currentUser, showMessage, showToast, appId, focusSearchInput]);

    // Function to add a custom game to the library
    const addCustomGameToLibrary = useCallback(async (gameData) => {
        if (!db || !currentUser) {
            console.warn("[AddCustomGame] Firebase not initialized or currentUser missing.");
            showMessage("Please log in to add custom games.", 'error');
            return;
        }
        setLoading(true);
        // console.log(`[AddCustomGame] Attempting to add custom game: ${gameData.name}`); // Removed for performance
        try {
            const gamesCollectionRef = collection(db, `artifacts/${appId}/public/data/games`);
            await addDoc(gamesCollectionRef, {
                ...gameData,
                ownerId: currentUser.uid,
                checkoutCount: 0,
                isCheckedOut: false,
                lastCheckedOutBy: '',
                lastCheckedOutDate: null,
                lastCheckedInDate: null,
                isExpansion: false, // Custom games are not expansions by default
                baseGameBggId: null, // No base game for custom entries
                isRemoved: false,
                isCustom: true, // Mark as custom entry
            });
            showToast(`"${gameData.name}" added to the library.`);
            setAddingCustomGame(false); // Close the modal
        } catch (error) {
            console.error("[AddCustomGame] Error adding custom game:", error);
            showMessage("Error adding custom game. Please try again.", 'error');
        } finally {
            setLoading(false);
            focusSearchInput(); // Focus search input after operation
        }
    }, [db, currentUser, showMessage, showToast, appId, focusSearchInput]);

    // Delete every game document (conventions are kept).
    // Confirmation happens in the Settings page's type-to-confirm modal.
    const performClearAllData = useCallback(async () => {
        if (!db || !currentUser) { // Check currentUser
            console.warn("[ClearAllData] Firebase not initialized or currentUser missing.");
            showMessage("Please log in to clear data.", 'error');
            return;
        }
        setLoading(true);
        try {
            // Delete all games
            const gamesCollectionRef = collection(db, `artifacts/${appId}/public/data/games`);
            const gamesSnapshot = await getDocs(gamesCollectionRef);
            const gameDeletePromises = gamesSnapshot.docs.map(doc => deleteDoc(doc.ref));
            await Promise.all(gameDeletePromises);

            // Conventions are NOT deleted as per user request
            showToast("All game and checkout data has been cleared permanently.");
            setCurrentConventionId(null); // Deselect any active convention
        } catch (error) {
            console.error("[ClearAllData] Error clearing all data:", error);
            showMessage("Error clearing all data. Please try again.", 'error');
        } finally {
            setLoading(false);
        }
    }, [db, currentUser, showMessage, showToast, appId, setCurrentConventionId]);

    // Reset all checkout data (overall and convention-specific).
    // Confirmation happens in the Settings page's type-to-confirm modal.
    const performClearAllCheckoutData = useCallback(async () => {
        if (!db || !currentUser) {
            console.warn("[ClearAllCheckoutData] Firebase not initialized or currentUser missing.");
            showMessage("Please log in to clear checkout data.", 'error');
            return;
        }
        setLoading(true);
        try {
            // 1. Reset checkout data for all games in the main 'games' collection
            const gamesCollectionRef = collection(db, `artifacts/${appId}/public/data/games`);
            const gamesSnapshot = await getDocs(gamesCollectionRef);
            const gameUpdatePromises = gamesSnapshot.docs.map(async (docSnapshot) => {
                const gameData = docSnapshot.data();
                if (gameData.checkoutCount > 0 || gameData.isCheckedOut || gameData.lastCheckedOutBy || gameData.lastCheckedOutDate || gameData.lastCheckedInDate) {
                    return updateDoc(doc(gamesCollectionRef, docSnapshot.id), {
                        checkoutCount: 0,
                        isCheckedOut: false,
                        lastCheckedOutBy: '',
                        lastCheckedOutDate: null,
                        lastCheckedInDate: null,
                    });
                }
                return Promise.resolve(); // No update needed if already reset
            });
            await Promise.all(gameUpdatePromises);
            console.log("[ClearAllCheckoutData] All main game checkout data reset.");

            // 2. Reset convention-specific checkout data for all games within all conventions
            const conventionsCollectionRef = collection(db, `artifacts/${appId}/public/data/conventions`);
            const conventionsSnapshot = await getDocs(conventionsCollectionRef);
            const conventionUpdatePromises = conventionsSnapshot.docs.map(async (convDocSnapshot) => {
                const convData = convDocSnapshot.data();
                const currentConvGames = convData.games || [];
                let needsConvUpdate = false;
                const updatedConvGames = currentConvGames.map(convGame => {
                    if (convGame.conventionCheckoutCount > 0 || convGame.isCheckedOutAtConvention || (Array.isArray(convGame.conventionCheckoutTimes) && convGame.conventionCheckoutTimes.length > 0)) {
                        needsConvUpdate = true;
                        return {
                            ...convGame,
                            conventionCheckoutCount: 0,
                            isCheckedOutAtConvention: false,
                            conventionCheckoutTimes: [],
                        };
                    }
                    return convGame;
                });

                if (needsConvUpdate) {
                    return updateDoc(doc(conventionsCollectionRef, convDocSnapshot.id), {
                        games: updatedConvGames,
                    });
                }
                return Promise.resolve(); // No update needed for this convention
            });
            await Promise.all(conventionUpdatePromises);
            console.log("[ClearAllCheckoutData] All convention checkout data reset.");

            showToast("All checkout data has been reset.");
        } catch (error) {
            console.error("[ClearAllCheckoutData] Error clearing checkout data:", error);
            showMessage("Error clearing checkout data. Please try again.", 'error');
        } finally {
            setLoading(false);
        }
    }, [db, currentUser, showMessage, showToast, appId]);


    return (
        <div className="dfwgv-library-app min-h-screen text-gray-100 font-sans flex flex-col items-stretch">
            <style>
                {`
                html, body, #root { /* Ensure full height for proper min-h-screen behavior */
                    height: 100%;
                    margin: 0;
                    padding: 0;
                    overflow: auto;
                }
                .scrollable-list {
                    max-height: 400px;
                    overflow-y: auto;
                    border: 1px solid #374151; /* gray-700 */
                    border-radius: 0.5rem;
                }
                .min-h-screen-minus-header {
                    min-height: calc(100vh - 150px); /* Adjust based on your header height */
                }
                `}
            </style>

            <AppTopbar
                currentUser={currentUser}
                logout={logout}
                conventions={conventions}
                currentConvention={currentConvention}
                setCurrentConventionId={setCurrentConventionId}
                goToConventions={() => setCurrentPage('allConventions')}
            />

            {/* Loading overlay for general app operations (imports show inline progress instead) */}
            {loading && !importStatus && (
                <div className="fixed inset-0 bg-gray-800 bg-opacity-75 flex items-center justify-center z-50">
                    <div className="animate-spin rounded-full h-20 w-20 border-t-4 border-b-4 border-blue-400"></div>
                    <p className="ml-4 text-xl text-blue-300">Loading...</p>
                </div>
            )}

            <MessageBox message={message} type={messageType} onClose={closeMessage} onConfirm={confirmAction} />
            <ToastStack toasts={toasts} />

            {/* Conditional rendering based on authentication state */}
            {loadingAuth ? (
                <div className="flex items-center justify-center min-h-screen bg-gray-900">
                    <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-blue-500"></div>
                    <p className="ml-4 text-lg text-gray-300">Checking authentication status...</p>
                </div>
            ) : !currentUser ? (
                <AuthPage
                    login={login} // Pass login from AuthContext directly
                    loadingAuth={loadingAuth}
                    showMessage={showMessage}
                />
            ) : (
                <main className="dfwgv-library-main">
                    {/* Single tab bar: every page is one click away, counts give live context */}
                    <nav className="dfwgv-tabs" aria-label="Library manager pages">
                        <button
                            onClick={() => setCurrentPage('home')}
                            className={`dfwgv-tab ${currentPage === 'home' ? 'active' : ''}`}
                        >
                            Home
                        </button>
                        <button
                            onClick={() => setCurrentPage('checkedOutGames')}
                            className={`dfwgv-tab ${currentPage === 'checkedOutGames' ? 'active' : ''}`}
                        >
                            Checked Out
                            <span className="dfwgv-tab-count">{currentConvention ? currentConvention.games.filter(g => g.isCheckedOutAtConvention).length : 0}</span>
                        </button>
                        <button
                            onClick={() => setCurrentPage('library')}
                            className={`dfwgv-tab ${currentPage === 'library' ? 'active' : ''}`}
                        >
                            Library
                            <span className="dfwgv-tab-count">{games.length}</span>
                        </button>
                        <button
                            onClick={() => setCurrentPage('allConventions')}
                            className={`dfwgv-tab ${currentPage === 'allConventions' ? 'active' : ''}`}
                        >
                            Conventions
                            <span className="dfwgv-tab-count">{conventions.length}</span>
                        </button>
                        <button
                            onClick={() => setCurrentPage('import')}
                            className={`dfwgv-tab ${currentPage === 'import' ? 'active' : ''}`}
                        >
                            Import
                        </button>
                        <button
                            onClick={() => setCurrentPage('removed')}
                            className={`dfwgv-tab ${currentPage === 'removed' ? 'active' : ''}`}
                        >
                            Removed
                            <span className="dfwgv-tab-count">{removedGames.length}</span>
                        </button>
                        <span className="dfwgv-tab-spacer"></span>
                        <button
                            onClick={() => setCurrentPage('settings')}
                            className={`dfwgv-tab ${currentPage === 'settings' ? 'active' : ''}`}
                            title="Settings and danger zone"
                        >
                            ⚙ Settings
                        </button>
                    </nav>

                    {/* Conditional Rendering of Pages */}
                    <div className="pt-6 sm:pt-8 w-full flex justify-center">
                        {currentPage === 'home' && (
                            <HomeView
                                loading={loading}
                                conventions={conventions}
                                currentConvention={currentConvention} // Pass the derived object
                                exportConventionGamesToCsv={exportConventionGamesToCsv}
                                games={games}
                                toggleGameForConvention={toggleGameForConvention}
                                toggleGameConventionCheckout={toggleGameConventionCheckout}
                                showMessage={showMessage}
                                setCurrentConventionId={setCurrentConventionId} // Pass the ID setter
                                homeSearchInputRef={homeSearchInputRef} // Pass ref
                                homeSearchTerm={homeSearchTerm} // Pass state value
                                setHomeSearchTerm={setHomeSearchTerm} // Pass state setter
                                gamesByIdMap={gamesByIdMap} // Pass gamesByIdMap
                                goToConventions={() => setCurrentPage('allConventions')}
                                copyPublicLink={copyPublicLink}
                            />
                        )}

                        {currentPage === 'import' && (
                            <ImportCollectionsPage
                                importGames={importGames}
                                loading={loading}
                                showMessage={showMessage}
                                importStatus={importStatus}
                                importResults={importResults}
                            />
                        )}

                        {currentPage === 'library' && (
                            <GameLibraryPage
                                games={games} // Active games only
                                toggleGameForConvention={toggleGameForConvention}
                                currentConvention={currentConvention} // Pass the derived object
                                loading={loading}
                                showMessage={showMessage}
                                removeGameFromLibrary={removeGameFromLibrary}
                                onAddCustomGame={() => setAddingCustomGame(true)} // New prop to open modal
                                librarySearchInputRef={librarySearchInputRef} // Pass ref
                                searchTerm={searchTerm} // Pass state value
                                setSearchTerm={setSearchTerm} // Pass state setter
                                gamesByIdMap={gamesByIdMap} // Pass gamesByIdMap
                            />
                        )}

                        {currentPage === 'settings' && (
                            <SettingsPage
                                performClearAllCheckoutData={performClearAllCheckoutData}
                                performClearAllData={performClearAllData}
                                loading={loading}
                            />
                        )}

                        {currentPage === 'removed' && (
                            <RemovedGamesPage
                                removedGames={removedGames}
                                reAddGameToLibrary={reAddGameToLibrary}
                                loading={loading}
                                showMessage={showMessage}
                            />
                        )}

                        {currentPage === 'allConventions' && (
                            <AllConventionsPage
                                conventions={conventions}
                                currentConvention={currentConvention}
                                createConvention={createConvention}
                                deleteConvention={deleteConvention}
                                updateConvention={updateConvention}
                                loading={loading}
                                showMessage={showMessage}
                                setCurrentConventionId={setCurrentConventionId}
                                setEditingConvention={setEditingConvention}
                                copyPublicLink={copyPublicLink}
                                isAdmin={isAdmin}
                                onSyncPlanner={(conv) => setSyncingConventionId(conv.id)}
                            />
                        )}

                        {syncingConventionId && (() => {
                            const syncingConvention = conventions.find(conv => conv.id === syncingConventionId);
                            return syncingConvention ? (
                                <SyncPlannerModal
                                    convention={syncingConvention}
                                    onClose={() => setSyncingConventionId(null)}
                                    onSync={(gameday) => linkPlannerEvent(syncingConventionId, gameday)}
                                    onUnlink={() => unlinkPlannerEvent(syncingConventionId)}
                                    syncBusy={plannerSyncBusy}
                                />
                            ) : null;
                        })()}

                        {currentPage === 'checkedOutGames' && (
                            <CheckedOutGamesPage
                                currentConvention={currentConvention}
                                toggleGameConventionCheckout={toggleGameConventionCheckout}
                                loading={loading}
                                showMessage={showMessage}
                                homeSearchInputRef={homeSearchInputRef} // Pass ref
                                librarySearchInputRef={librarySearchInputRef} // Pass ref
                                currentPage={currentPage} // Pass current page to determine which ref to focus
                            />
                        )}

                        {editingConvention && (
                            <EditConventionModal
                                convention={editingConvention}
                                onClose={() => setEditingConvention(null)}
                                onSave={updateConvention}
                                loading={loading}
                                showMessage={showMessage}
                            />
                        )}

                        {/* New: Render AddCustomGameModal */}
                        {addingCustomGame && (
                            <AddCustomGameModal
                                onClose={() => setAddingCustomGame(false)}
                                onSave={addCustomGameToLibrary}
                                loading={loading}
                                showMessage={showMessage}
                            />
                        )}
                    </div>
                </main>
            )}
        </div>
    );
};

// Public, read-only live view of one convention, reached via ?con=<conventionId>.
// No auth: Firestore rules allow anonymous `get` of a single convention document,
// and the onSnapshot listener keeps the page updated in real time.
const PublicConventionPage = ({ conventionId }) => {
    const { db, appId } = useContext(FirebaseContext);
    const [convention, setConvention] = useState(null);
    const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState('all'); // 'all' | 'available' | 'out'
    const [view, setView] = useState('library'); // 'library' | 'tables' (tabs appear when a Planner event is linked)
    const debouncedSearch = useDebounce(search, 200);

    useEffect(() => {
        if (!db || !conventionId) return;
        const conventionRef = doc(db, `artifacts/${appId}/public/data/conventions`, conventionId);
        const unsubscribe = onSnapshot(conventionRef, (snapshot) => {
            if (snapshot.exists()) {
                setConvention({ id: snapshot.id, ...snapshot.data() });
                setStatus('ready');
            } else {
                setStatus('error');
            }
        }, (error) => {
            console.error('[PublicConvention] Failed to load convention:', error);
            setStatus('error');
        });
        return () => unsubscribe();
    }, [db, appId, conventionId]);

    const allGames = useMemo(() => (convention?.games || []).filter(g => g && g.name), [convention?.games]);

    const visibleGames = useMemo(() => {
        const query = String(debouncedSearch).toLowerCase();
        return allGames
            .filter(g => String(g.name).toLowerCase().includes(query))
            .filter(g => {
                if (filter === 'available') return !g.isCheckedOutAtConvention;
                if (filter === 'out') return !!g.isCheckedOutAtConvention;
                return true;
            })
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }, [allGames, debouncedSearch, filter]);

    const checkedOutCount = useMemo(() => allGames.filter(g => g.isCheckedOutAtConvention).length, [allGames]);

    // Re-render every minute so "out for X min" stays current between snapshots
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 60000);
        return () => clearInterval(timer);
    }, []);

    // Live hosted tables from the linked Planner event: a second read-only
    // Firestore connection subscribes to the gameday's tables subcollection, so
    // new tables appear here the moment hosts create them in the Planner.
    const plannerGamedayId = convention?.plannerEvent?.gamedayId || null;
    const [plannerTables, setPlannerTables] = useState([]);

    useEffect(() => {
        if (!plannerGamedayId) {
            setPlannerTables([]);
            return;
        }
        try {
            const plannerDb = getPlannerDb();
            const tablesRef = collection(plannerDb, 'gamedays', plannerGamedayId, 'tables');
            const unsubscribe = onSnapshot(tablesRef, (snapshot) => {
                setPlannerTables(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
            }, (error) => {
                console.error('[PublicConvention] Planner tables listener failed:', error);
                setPlannerTables([]);
            });
            return () => unsubscribe();
        } catch (error) {
            console.error('[PublicConvention] Planner connection failed:', error);
            setPlannerTables([]);
        }
    }, [plannerGamedayId]);

    // Tables ordered by start time — the Planner schedules everything in
    // America/Chicago, so display follows suit.
    const plannerTablesSorted = useMemo(() => {
        return [...plannerTables].sort((a, b) =>
            (toDateSafe(a.startTime)?.getTime() || 0) - (toDateSafe(b.startTime)?.getTime() || 0)
        );
    }, [plannerTables]);

    // "Fri, Aug 21 · 5:00 PM" in Central time
    const formatTableWhen = (value) => {
        const d = toDateSafe(value);
        if (!d) return 'Time TBD';
        const day = d.toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric' });
        const time = d.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
        return `${day} · ${time}`;
    };

    // How long the current checkout has been running; the last entry in
    // conventionCheckoutTimes is when the active checkout started.
    const checkoutDuration = (game) => {
        if (!game.isCheckedOutAtConvention) return null;
        const times = Array.isArray(game.conventionCheckoutTimes) ? game.conventionCheckoutTimes : [];
        if (times.length === 0) return null;
        const start = new Date(times[times.length - 1]).getTime();
        if (Number.isNaN(start) || start > now) return null;
        const mins = Math.floor((now - start) / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins} min`;
        const hours = Math.floor(mins / 60);
        const rest = mins % 60;
        return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
    };

    return (
        <div className="dfwgv-library-app min-h-screen flex flex-col">
            <header className="dfwgv-topbar dfwgv-public-topbar">
                <div className="dfwgv-brand">
                    <a className="dfwgv-logo" href="https://www.dfwgamingvillage.com/" aria-label="Go to DFW Gaming Village home">
                        <img src={`${process.env.PUBLIC_URL}/dfwgv-icon.png`} alt="DFW Gaming Village logo" />
                    </a>
                    <div className="dfwgv-brandText">
                        <div className="dfwgv-title">DFW Gaming Village</div>
                        <div className="dfwgv-subtitle">Convention game library</div>
                    </div>
                </div>
                <span className="dfwgv-live-badge"><span className="dfwgv-live-dot" aria-hidden="true"></span> Live</span>
            </header>

            <main className="dfwgv-public-main">
                {status === 'loading' && (
                    <p className="text-gray-300 text-center">Loading the game library…</p>
                )}

                {status === 'error' && (
                    <section className="bg-gray-800 p-6 rounded-xl border border-gray-700">
                        <div className="dfwgv-empty">
                            <h3>This library isn't available</h3>
                            <p>The link may be wrong, or this convention is no longer shared. Ask the library team for a fresh link.</p>
                        </div>
                    </section>
                )}

                {status === 'ready' && convention && (
                    <>
                        <section className="dfwgv-public-hero bg-gray-800 rounded-xl border border-gray-700">
                            <p className="eyebrow">DFW Gaming Village presents</p>
                            <h1>{convention.name}</h1>
                            <p className="when">
                                📅 {new Date(convention.startDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                                {' – '}
                                {new Date(convention.endDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                                {convention.plannerEvent?.location ? ` · 📍 ${convention.plannerEvent.location}` : ''}
                            </p>
                            <p className="explain">
                                Every game below is free to borrow during the event — find one that's{' '}
                                <span className="dfwgv-pill ok">Available</span> and bring it to the library
                                table to check it out.
                                {plannerGamedayId ? ' You can also browse scheduled tables and grab a seat.' : ''}
                                {' '}This page updates live all weekend.
                            </p>
                            <p className="counts">
                                <b>{allGames.length}</b> games in the library · <b>{allGames.length - checkedOutCount}</b> available right now
                            </p>
                        </section>

                        {plannerGamedayId && (
                            <nav className="dfwgv-public-tabs" aria-label="Page sections">
                                <button
                                    className={`dfwgv-public-tab ${view === 'library' ? 'active' : ''}`}
                                    onClick={() => setView('library')}
                                >
                                    🎲 Game Library <span className="count">{allGames.length}</span>
                                </button>
                                <button
                                    className={`dfwgv-public-tab ${view === 'tables' ? 'active' : ''}`}
                                    onClick={() => setView('tables')}
                                >
                                    🗓 Hosted Tables <span className="count">{plannerTablesSorted.length}</span>
                                </button>
                            </nav>
                        )}

                        {view === 'tables' && plannerGamedayId && (
                            <section className="bg-gray-800 p-6 rounded-xl border border-gray-700">
                                <div className="dfwgv-tables-intro">
                                    <p className="text-gray-300 text-sm m-0">
                                        Community members host scheduled game sessions through the DFWGV Planner —
                                        green dots are open seats. Times are Central.
                                    </p>
                                    <a
                                        className="dfwgv-btn dfwgv-btn-primary dfwgv-planner-cta"
                                        href={`https://www.dfwgamingvillage.com/planner/events/?id=${plannerGamedayId}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        Join or Host a table →
                                    </a>
                                </div>
                                {plannerTablesSorted.length === 0 ? (
                                    <p className="text-gray-400 m-0">No tables scheduled yet — be the first to host one!</p>
                                ) : (
                                    <ul className="dfwgv-planner-tables">
                                        {plannerTablesSorted.map(table => {
                                            const cap = Number(table.capacity || 0);
                                            const confirmed = Number(table.confirmedCount || 0);
                                            const waitlist = Number(table.waitlistCount || 0);
                                            const isFull = cap > 0 && confirmed >= cap;
                                            const openSeats = Math.max(cap - confirmed, 0);
                                            const usePips = cap > 0 && cap <= 12;
                                            return (
                                                <li key={table.id} className="dfwgv-planner-table">
                                                    <img
                                                        className="dfwgv-planner-thumb"
                                                        src={table.thumbUrl || `https://placehold.co/96x96/18181c/b8b8c2?text=No+Img`}
                                                        alt={table.gameName || 'Game'}
                                                        loading="lazy"
                                                    />
                                                    <div className="dfwgv-planner-info">
                                                        <span className="dfwgv-planner-game">
                                                            {table.bggId ? (
                                                                <a href={`https://boardgamegeek.com/boardgame/${table.bggId}`} target="_blank" rel="noopener noreferrer">
                                                                    {table.gameName}
                                                                </a>
                                                            ) : table.gameName}
                                                        </span>
                                                        <span className="dfwgv-planner-host">Host: {table.hostDisplayName || 'TBD'}</span>
                                                    </div>
                                                    <div className="dfwgv-planner-right">
                                                        <span className="dfwgv-planner-time">{formatTableWhen(table.startTime)}</span>
                                                        {cap > 0 && (
                                                            <div className={`dfwgv-planner-seatswrap ${isFull ? 'is-full' : ''}`}>
                                                                <span className="dfwgv-planner-seats">
                                                                    {isFull
                                                                        ? `Full · ${confirmed}/${cap} seats`
                                                                        : `${confirmed}/${cap} seats · ${openSeats} open`}
                                                                    {waitlist ? ` · +${waitlist} waitlist` : ''}
                                                                </span>
                                                                {usePips ? (
                                                                    <span className="dfwgv-seat-pips" aria-hidden="true">
                                                                        {Array.from({ length: cap }, (_, i) => (
                                                                            <span key={i} className={`dfwgv-seat-dot${i < Math.min(confirmed, cap) ? ' is-filled' : ''}`}></span>
                                                                        ))}
                                                                    </span>
                                                                ) : (
                                                                    <span className="dfwgv-seats-bar" aria-hidden="true">
                                                                        <span
                                                                            className="dfwgv-seats-fill"
                                                                            style={{ width: `${Math.min(100, Math.round((confirmed / cap) * 100))}%` }}
                                                                        ></span>
                                                                    </span>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                            </section>
                        )}

                        {(view === 'library' || !plannerGamedayId) && (
                            <>
                                <div className="dfwgv-public-toolbar">
                                    <input
                                        type="search"
                                        placeholder={`🔍 Search ${allGames.length} games…`}
                                        className="dfwgv-public-search"
                                        value={search}
                                        onChange={(e) => setSearch(e.target.value)}
                                        aria-label="Search games"
                                    />
                                    <div className="dfwgv-filter-chips" role="group" aria-label="Filter by availability">
                                        <button
                                            className={`dfwgv-chip ${filter === 'all' ? 'active' : ''}`}
                                            onClick={() => setFilter('all')}
                                        >
                                            All · {allGames.length}
                                        </button>
                                        <button
                                            className={`dfwgv-chip ${filter === 'available' ? 'active' : ''}`}
                                            onClick={() => setFilter('available')}
                                        >
                                            Available · {allGames.length - checkedOutCount}
                                        </button>
                                        <button
                                            className={`dfwgv-chip ${filter === 'out' ? 'active' : ''}`}
                                            onClick={() => setFilter('out')}
                                        >
                                            Checked out · {checkedOutCount}
                                        </button>
                                    </div>
                                </div>

                                {visibleGames.length === 0 ? (
                                    <p className="text-gray-400 text-center">No games match — try a different search or filter.</p>
                                ) : (
                                    <ul className="dfwgv-game-grid">
                                        {visibleGames.map(game => {
                                            const isOut = !!game.isCheckedOutAtConvention;
                                            const duration = checkoutDuration(game);
                                            const badgeLabel = isOut
                                                ? (duration && duration !== 'just now' ? `Out · ${duration}` : 'Checked out')
                                                : 'Available';
                                            return (
                                                <li key={game.id} className={`dfwgv-game-card${isOut ? ' out' : ''}`}>
                                                    <div className="art-wrap">
                                                        <img
                                                            className="art"
                                                            src={game.thumbnail || `https://placehold.co/200x200/18181c/b8b8c2?text=No+Img`}
                                                            alt={game.name}
                                                            loading="lazy"
                                                        />
                                                    </div>
                                                    <div className={`status ${isOut ? 'out' : 'ok'}`}>
                                                        <span className="dot" aria-hidden="true"></span>{badgeLabel}
                                                    </div>
                                                    <div className="body">
                                                        <span className="name">
                                                            {game.bggId ? (
                                                                <a href={`https://boardgamegeek.com/boardgame/${game.bggId}`} target="_blank" rel="noopener noreferrer">
                                                                    {game.name}
                                                                </a>
                                                            ) : game.name}
                                                        </span>
                                                        <span className="meta">
                                                            👥 {game.minPlayers || '?'}–{game.maxPlayers || '?'} · ⏱ {game.playingTime || '?'} min
                                                            {(typeof game.averageRating === 'number') ? <> · <span className="star">★</span> {game.averageRating.toFixed(1)}</> : null}
                                                        </span>
                                                    </div>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                            </>
                        )}

                        <div className="dfwgv-public-footer">
                            Availability updates automatically · <a href="https://www.dfwgamingvillage.com/">DFW Gaming Village</a>
                        </div>
                    </>
                )}
            </main>
        </div>
    );
};

// A ?con=<conventionId> URL serves the public read-only view; everything else gets the full app.
const publicConventionId = new URLSearchParams(window.location.search).get('con');

// Root component now wraps with FirebaseSetup and AuthProvider
const Root = () => (
    <FirebaseSetup>
        {publicConventionId ? (
            <PublicConventionPage conventionId={publicConventionId} />
        ) : (
            <AuthProvider>
                <App />
            </AuthProvider>
        )}
    </FirebaseSetup>
);

export default Root;
