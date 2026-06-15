/* global __firebase_config, __app_id, __initial_auth_token */
import React, { useState, useEffect, createContext, useContext, useRef, useCallback, memo, useMemo } from 'react'; // Added useMemo
import { initializeApp } from 'firebase/app';
import * as FirebaseAuth from 'firebase/auth'; // Import all from firebase/auth as FirebaseAuth
import { getFirestore, doc, getDoc, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot, collection, getDocs } from 'firebase/firestore';

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
        <div className="fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center z-50 p-4">
            <div className="bg-gray-800 rounded-lg shadow-xl p-6 max-w-sm w-full border border-gray-700">
                <p className="text-gray-100 text-lg mb-4">{message}</p>
                <div className="flex justify-end space-x-3">
                    {type === 'confirm' && (
                        <button
                            onClick={onConfirm}
                            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-opacity-50"
                        >
                            Confirm
                        </button>
                    )}
                    <button
                        onClick={onClose}
                        className="px-4 py-2 bg-gray-600 text-gray-100 rounded-md hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-600 focus:ring-opacity-50"
                    >
                        {type === 'confirm' ? 'Cancel' : 'Close'}
                    </button>
                </div>
            </div>
        </div>
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
                        className="w-full bg-blue-600 text-white py-3 px-6 rounded-lg text-lg font-semibold hover:bg-blue-700 transition duration-300 ease-in-out shadow-md"
                        disabled={loadingAuth}
                    >
                        {loadingAuth ? 'Logging in...' : 'Login'}
                    </button>
                </form>
            </div>
        </div>
    );
});


// Home View Component definition
const HomeView = memo(({
    loading,
    currentConvention,
    exportConventionGamesToCsv, toggleGameForConvention, toggleGameConventionCheckout, showMessage, setCurrentConventionId,
    homeSearchInputRef, homeSearchTerm, setHomeSearchTerm, gamesByIdMap, conventions
}) => {
    const debouncedHomeSearchTerm = useDebounce(homeSearchTerm, 300); // Debounce search input
    const [showTopCheckouts, setShowTopCheckouts] = useState(false);

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

            return (
                gameName.toLowerCase().includes(searchLower) ||
                ownerName.toLowerCase().includes(searchLower)
            );
        });

        return filtered.sort((a, b) => {
            const nameA = gamesByIdMap.get(a.id)?.name || a.name;
            const nameB = gamesByIdMap.get(b.id)?.name || b.name;
            return String(nameA).localeCompare(String(nameB));
        });
    }, [currentConvention, gamesByIdMap, debouncedHomeSearchTerm]);

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
        if (!currentConvention?.games) return [];
        const counts = new Map();
        for (const g of currentConvention.games) {
            const times = Array.isArray(g.conventionCheckoutTimes) ? g.conventionCheckoutTimes : [];
            for (const iso of times) {
                const d = new Date(iso);
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                counts.set(key, (counts.get(key) || 0) + 1);
            }
        }
        return Array.from(counts.entries())
            .sort((a, b) => (a[0] < b[0] ? 1 : -1))
            .map(([date, count]) => ({ date, count }));
    }, [currentConvention?.games]);

    return (
        <div className="w-full max-w-4xl">
            <section className="bg-gray-800 p-6 rounded-xl shadow-lg mb-8 w-full border border-gray-700">
                <h2 className="text-2xl font-semibold text-blue-400 mb-4">Manage Selected Convention</h2>
                {!currentConvention ? (
                    <p className="text-gray-400">Please select a convention from the "All Conventions" tab to manage its games.</p>
                ) : (
                    <div>
                        <h3 className="text-xl font-semibold text-blue-300 mb-3">Currently Managing: {currentConvention.name} ({new Date(currentConvention.startDate).toLocaleDateString()} - {new Date(currentConvention.endDate).toLocaleDateString()})</h3>
                        <button
                            onClick={() => {
                                setCurrentConventionId(null);
                            }}
                            className="px-4 py-2 bg-gray-600 text-gray-100 rounded-lg font-semibold hover:bg-gray-700 transition duration-300 ease-in-out shadow-md mb-4"
                        >
                            Deselect Current Convention
                        </button>
                        <div className="text-gray-300 mb-4 flex items-center justify-between">
                            <span>Games for this convention: {gamesInCurrentConventionFilteredBySearch.length || 0}</span>
                            <div className="flex items-center gap-3">
                                <span className="whitespace-nowrap">Total checkouts: <span className="font-semibold">{totalConventionCheckouts}</span></span>
                                <button onClick={() => setShowTopCheckouts(true)} className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md" title="Show most-checked-out games for this convention">Top checkouts</button>
                            </div>
                        </div>
                        {dailyConventionCheckoutTotals.length > 0 && (
                            <div className="mb-4 p-3 bg-gray-700 border border-gray-600 rounded-lg">
                                <h4 className="text-lg font-semibold text-blue-300 mb-2">Daily checkouts</h4>
                                <ul className="space-y-1">
                                    {dailyConventionCheckoutTotals.map(row => (
                                        <li key={row.date} className="flex justify-between text-gray-100">
                                            <span>{new Date(row.date + 'T00:00:00').toLocaleDateString()}</span>
                                            <span className="font-bold">{row.count}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        <button
                            onClick={exportConventionGamesToCsv}
                            className="bg-purple-700 text-white py-2 px-5 rounded-lg font-semibold hover:bg-purple-800 transition duration-300 ease-in-out shadow-md"
                            disabled={loading || gamesInCurrentConventionFilteredBySearch.length === 0}
                        >
                            Export Convention Games to CSV
                        </button>

                        <div className="mt-4 mb-4 flex items-center gap-4">
                            <input
                                type="text"
                                placeholder={`Search games in ${currentConvention.name}...`}
                                className="w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 placeholder-gray-400 focus:ring-blue-500 focus:border-blue-500"
                                value={homeSearchTerm}
                                onChange={(e) => setHomeSearchTerm(e.target.value)}
                                ref={homeSearchInputRef}
                            />
                        </div>

                        <div className="mt-4 scrollable-list bg-gray-700 p-3 border border-gray-600">
                            {gamesInCurrentConventionFilteredBySearch.length === 0 ? (
                                <p className="text-gray-400">No games found matching your search in this convention.</p>
                            ) : (
                                <ul className="space-y-3">
                                    {gamesInCurrentConventionFilteredBySearch.map(convGame => {
                                        if (!convGame || typeof convGame.id === 'undefined') {
                                            return null;
                                        }

                                        const fullGameData = gamesByIdMap.get(convGame.id);

                                        const displayMinPlayers = fullGameData?.minPlayers || convGame.minPlayers || 'N/A';
                                        const displayMaxPlayers = fullGameData?.maxPlayers || convGame.maxPlayers || 'N/A';
                                        const displayPlayingTime = fullGameData?.playingTime || convGame.playingTime || 'N/A';
                                        const displayAverageRating = (typeof (fullGameData?.averageRating ?? convGame.averageRating) === 'number') ? (fullGameData?.averageRating ?? convGame.averageRating).toFixed(2) : 'N/A';

                                        const checkoutButtonClasses = `px-3 py-1 rounded-lg font-semibold text-xs transition duration-300 ease-in-out shadow-sm ${convGame.isCheckedOutAtConvention ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'} text-white`;
                                        return (
                                            <li key={convGame.id} className="flex flex-col items-start gap-4 bg-gray-900 p-4 rounded-md shadow-sm border border-gray-700">
                                                <div className="flex flex-col sm:flex-row items-start sm:items-center w-full gap-4">
                                                    <img src={convGame.thumbnail || `https://placehold.co/80x80/2d3748/cbd5e0?text=No+Img`} alt={convGame.name} className="w-20 h-20 object-cover rounded-md flex-shrink-0" />
                                                    <div className="flex-grow">
                                                        <h3 className="text-lg font-semibold text-gray-100">
                                                            <a href={`https://boardgamegeek.com/boardgame/${convGame.bggId}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline">
                                                                {convGame.name}
                                                            </a>
                                                        </h3>
                                                        <p className="text-sm text-gray-300">Owned by: <span className="font-medium text-blue-400">{convGame.ownerName}</span></p>
                                                        <p className="text-sm text-gray-300">Players: {displayMinPlayers}-{displayMaxPlayers} | Playtime: {displayPlayingTime} min</p>
                                                        <p className="text-sm text-gray-300 flex items-center">
                                                            BGG Rating:
                                                            <span
                                                                className="ml-2 text-gray-300 text-xs font-semibold"
                                                            >
                                                                {displayAverageRating}
                                                            </span>
                                                        </p>
                                                        <p className="text-sm text-gray-300">
                                                            Status: <span className={`font-semibold ${convGame.isCheckedOutAtConvention ? 'text-red-400' : 'text-green-400'}`}>
                                                                {convGame.isCheckedOutAtConvention ? 'Checked Out' : 'Available'}
                                                            </span>
                                                            <span className="ml-2">| Convention Checkouts: {convGame.conventionCheckoutCount}</span>
                                                        </p>
                                                    </div>
                                                    <div className="flex flex-col sm:flex-row gap-2 mt-3 sm:mt-0">
                                                        <button
                                                            onClick={() => toggleGameConventionCheckout(convGame, currentConvention.id)}
                                                            className={checkoutButtonClasses}
                                                            disabled={loading}
                                                        >
                                                            {convGame.isCheckedOutAtConvention ? 'Check In' : 'Check Out'}
                                                        </button>
                                                        <button
                                                            onClick={() => toggleGameForConvention(convGame, currentConvention.id)}
                                                            className="px-3 py-1 bg-red-700 text-white rounded-md text-xs hover:bg-red-800 transition duration-300 ease-in-out"
                                                        >
                                                            Remove
                                                        </button>
                                                    </div>
                                                </div>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </div>
                    </div>
                )}
            </section>
            {showTopCheckouts && (
                <div className="fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center z-50 p-4">
                    <div className="bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-lg border border-gray-700">
                        <div className="flex items-center justify-between mb-4">
                            <h4 className="text-xl font-semibold text-blue-300">
                                Top checkouts — {currentConvention?.name}
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
                            <ul className="divide-y divide-gray-700">
                                {topConventionCheckouts.map((g, i) => (
                                    <li key={g.id} className="py-2 flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <span className="text-gray-400 w-6 text-right">{i + 1}.</span>
                                            <div className="flex flex-col">
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
const ImportCollectionsPage = memo(({ importGames, loading, showMessage }) => {
    const [owner1BggUsername, setOwner1BggUsername] = useState('');
    const [owner2BggUsername, setOwner2BggUsername] = useState('');

    const handleImportGames = () => {
        importGames(owner1BggUsername, owner2BggUsername);
    };

    return (
        <section className="bg-gray-800 p-6 rounded-xl shadow-lg mb-8 w-full max-w-4xl border border-gray-700">
            <h2 className="text-2xl font-semibold text-blue-400 mb-4">Import BoardGameGeek Collections</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                <div>
                    <label htmlFor="owner1Bgg" className="block text-sm font-medium text-gray-300 mb-1">Owner 1 BGG Username</label>
                    <input
                        type="text"
                        id="owner1Bgg"
                        className="w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 placeholder-gray-400 focus:ring-blue-500 focus:border-blue-500"
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
                        className="w-full p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 placeholder-gray-400 focus:ring-blue-500 focus:border-blue-500"
                        value={owner2BggUsername}
                        onChange={(e) => setOwner2BggUsername(e.target.value)}
                        placeholder="e.g., bgg_user_two"
                    />
                </div>
            </div>
            <button
                onClick={handleImportGames}
                className="w-full bg-green-700 text-white py-3 px-6 rounded-lg text-lg font-semibold hover:bg-green-800 transition duration-300 ease-in-out shadow-md"
                disabled={loading}
            >
                Import Games from BoardGameGeek
            </button>
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
        <div className="fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center z-50 p-4">
            <div className="bg-gray-800 rounded-lg shadow-xl p-6 max-w-lg w-full border border-gray-700 overflow-y-auto max-h-[90vh]">
                <h2 className="text-2xl font-semibold text-blue-400 mb-4">Add Custom Game</h2>
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
                        className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition duration-300 ease-in-out"
                        disabled={loading}
                    >
                        Save Game
                    </button>
                    <button
                        onClick={onClose}
                        className="px-4 py-2 bg-gray-600 text-gray-100 rounded-md hover:bg-gray-700 transition duration-300 ease-in-out"
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
    games, toggleGameForConvention, currentConvention, loading, showMessage, removeGameFromLibrary, clearAllData, onAddCustomGame,
    librarySearchInputRef, searchTerm, setSearchTerm, clearAllCheckoutData, gamesByIdMap
}) => {
    // --- MOVED STATE DECLARATIONS TO TOP ---
    const scrollRef = useRef(0);
    const scrollPosition = useRef(0);
    const [selectedOwner, setSelectedOwner] = useState('All');
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
        }).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))); // Sort after filtering
    }, [games, debouncedSearchTerm, selectedOwner]); // Dependencies for useMemo


    return (
        <section className="bg-gray-800 p-6 rounded-xl shadow-lg mb-8 w-full max-w-4xl border border-gray-700">
            <h2 className="text-2xl font-semibold text-blue-400 mb-4">Your Combined Board Game Library</h2>
            <div className="mb-4 flex flex-col sm:flex-row gap-4">
                <input
                    type="text"
                    placeholder="Search games by name or owner..."
                    className="w-full sm:flex-grow p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 placeholder-gray-400 focus:ring-blue-500 focus:border-blue-500"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    ref={librarySearchInputRef}
                />
                <select
                    className="p-3 border border-gray-600 rounded-md bg-gray-700 text-gray-100 focus:ring-blue-500 focus:border-blue-500"
                    value={selectedOwner}
                    onChange={(e) => setSelectedOwner(e.target.value)}
                >
                    {uniqueOwners.map(owner => (
                        <option key={owner} value={owner}>{owner}</option>
                    ))}
                </select>
            </div>
            <p className="text-gray-300 mb-4">Total Games: {games.filter(g => !g.isRemoved).length} (showing {libraryFilteredGames.length} matching entries)</p>
            <button
                onClick={onAddCustomGame}
                className="mb-4 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition duration-300 ease-in-out shadow-md"
                disabled={loading}
            >
                Add Custom Game
            </button>
            <div ref={scrollRef} className="scrollable-list bg-gray-700 p-3 border border-gray-600">
                {libraryFilteredGames.length === 0 ? (
                    <p className="text-gray-400">No games found matching your search, or no games imported yet.</p>
                ) : (
                    <ul className="space-y-3">
                        {libraryFilteredGames.map(game => {
                            if (!game || typeof game.id === 'undefined') {
                                return null;
                            }
                            const isGameInCurrentConvention = currentConvention?.games?.some(g => g.id === game.id);
                            const isAddRemoveButtonDisabled = !currentConvention;

                            return (
                                <li key={game.id} className="flex flex-col items-start gap-4 bg-gray-900 p-4 rounded-md shadow-sm border border-gray-700">
                                    <div className="flex flex-col sm:flex-row items-start sm:items-center w-full gap-4">
                                        <img src={game.thumbnail || `https://placehold.co/80x80/2d3748/cbd5e0?text=No+Img`} alt={game.name} className="w-20 h-20 object-cover rounded-md flex-shrink-0" />
                                        <div className="flex-grow">
                                            <h3 className="text-lg font-semibold text-gray-100">
                                                <a href={`https://boardgamegeek.com/boardgame/${game.bggId}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline">
                                                    {game.name}
                                                </a>
                                            </h3>
                                            <p className="text-sm text-gray-300">Owned by: <span className="font-medium text-blue-400">{game.ownerName}</span></p>
                                            <p className="text-sm text-gray-300">Players: {game.minPlayers || 'N/A'}-{game.maxPlayers || 'N/A'} | Playtime: {game.playingTime || 'N/A'} min</p>
                                            <p className="text-sm text-gray-300 flex items-center">
                                                BGG Rating:
                                                <span
                                                    className="ml-2 text-gray-300 text-xs font-semibold"
                                                >
                                                    {(typeof game.averageRating === 'number') ? game.averageRating.toFixed(2) : 'N/A'}
                                                </span>
                                            </p>
                                            <p className="text-sm text-gray-300">
                                                Status: <span className={`font-semibold ${game.isCheckedOut ? 'text-red-400' : 'text-green-400'}`}>
                                                    {game.isCheckedOut ? 'Checked Out' : 'Available'}
                                                </span>
                                                <span className="ml-2">| Overall Checkouts: {game.checkoutCount}</span>
                                            </p>
                                        </div>
                                        <div className="flex flex-col sm:flex-row gap-2 mt-3 sm:mt-0">
                                            <button
                                                onClick={() => toggleGameForConvention(game, currentConvention?.id)}
                                                className={`px-4 py-2 rounded-lg font-semibold transition duration-300 ease-in-out shadow-md ${isGameInCurrentConvention ? 'bg-yellow-600 hover:bg-yellow-700' : 'bg-blue-600 hover:bg-blue-700'} text-white ${isAddRemoveButtonDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                                                disabled={loading || isAddRemoveButtonDisabled}
                                                title={isAddRemoveButtonDisabled ? "Select a convention first to add/remove games" : ""}
                                            >
                                                {isGameInCurrentConvention ? 'Remove from Convention' : 'Add to Convention'}
                                            </button>
                                            <button
                                                onClick={() => showMessage(
                                                    `Are you sure you want to remove "${game.name} (${game.ownerName})" from the library? It will be moved to the "Removed Games" tab, but its historical data will be preserved.`,
                                                    'confirm',
                                                    () => removeGameFromLibrary(game)
                                                )}
                                                className="px-4 py-2 bg-red-700 text-white rounded-lg font-semibold hover:bg-red-800 transition duration-300 ease-in-out shadow-sm"
                                                disabled={loading}
                                            >
                                                Remove from Library
                                            </button>
                                        </div>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
            <div className="flex flex-col sm:flex-row justify-between items-center mt-8 gap-4">
                <button
                    onClick={clearAllData}
                    className="px-4 py-2 bg-red-800 text-white rounded-lg text-sm font-semibold hover:bg-red-900 transition duration-300 ease-in-out shadow-md w-full sm:w-auto"
                    disabled={loading}
                >
                    Clear All Data (DANGER!)
                </button>
                <button
                    onClick={clearAllCheckoutData}
                    className="px-4 py-2 bg-orange-700 text-white rounded-lg text-sm font-semibold hover:bg-orange-800 transition duration-300 ease-in-out shadow-md w-full sm:w-auto"
                    disabled={loading}
                    title="Resets all game and convention checkout counts to zero."
                >
                    Clear All Checkout Data
                </button>
            </div>
        </section>
    );
});

// New Removed Games Page Component definition
const RemovedGamesPage = memo(({ removedGames, reAddGameToLibrary, loading, showMessage }) => {
    return (
        <section className="bg-gray-800 p-6 rounded-xl shadow-lg mb-8 w-full max-w-4xl border border-gray-700">
            <h2 className="text-2xl font-semibold text-blue-400 mb-4">Games Removed From Library</h2>
            <p className="text-gray-300 mb-4">These games have been removed from the library.</p>
            <div className="scrollable-list bg-gray-700 p-3 border border-gray-600">
                {removedGames.length === 0 ? (
                    <p className="text-gray-400">No games have been removed from the library yet.</p>
                ) : (
                    <ul className="space-y-3">
                        {removedGames.map(game => {
                            if (!game || typeof game.id === 'undefined') {
                                return null;
                            }
                            return (
                                <li key={game.id} className="flex flex-col sm:flex-row items-start sm:items-center gap-4 bg-gray-900 p-4 rounded-md shadow-sm border border-gray-700">
                                    <img src={game.thumbnail || `https://placehold.co/80x80/2d3748/cbd5e0?text=No+Img`} alt={game.name} className="w-20 h-20 object-cover rounded-md flex-shrink-0" />
                                    <div className="flex-grow">
                                        <h3 className="text-lg font-semibold text-gray-100">
                                            <a href={`https://boardgamegeek.com/boardgame/${game.bggId}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline">
                                                {game.name}
                                            </a>
                                        </h3>
                                        <p className="text-sm text-gray-300">Owned by: <span className="font-medium text-blue-400">{game.ownerName}</span></p>
                                        <p className="text-sm text-gray-300">Overall Checkouts: {game.checkoutCount}</p>
                                        <p className="text-sm text-gray-300 flex items-center">
                                            BGG Rating:
                                            <span
                                                className="ml-2 text-gray-300 text-xs font-semibold"
                                            >
                                                {(typeof game.averageRating === 'number') ? game.averageRating.toFixed(2) : 'N/A'}
                                            </span>
                                        </p>
                                    </div>
                                    <div className="flex flex-col sm:flex-row gap-2 mt-3 sm:mt-0">
                                        <button
                                            onClick={() => showMessage(
                                                `Are you sure you want to re-add "${game.name} (${game.ownerName})" to the main library?`,
                                                'confirm',
                                                () => reAddGameToLibrary(game)
                                            )}
                                            className="px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition duration-300 ease-in-out shadow-sm"
                                            disabled={loading}
                                        >
                                            Re-add to Library
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
        <div className="fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center z-50 p-4">
            <div className="bg-gray-800 rounded-lg shadow-xl p-6 max-w-md w-full border border-gray-700">
                <h2 className="text-2xl font-semibold text-blue-400 mb-4">Edit Convention</h2>
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
                        className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition duration-300 ease-in-out"
                        disabled={loading}
                    >
                        Save Changes
                    </button>
                    <button
                        onClick={onClose}
                        className="px-4 py-2 bg-gray-600 text-gray-100 rounded-md hover:bg-gray-700 transition duration-300 ease-in-out"
                        disabled={loading}
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    );
});


// New All Conventions Page Component
const AllConventionsPage = memo(({
    conventions, currentConvention, createConvention, deleteConvention, updateConvention,
    loading, showMessage, setCurrentConventionId, setEditingConvention
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
                <h2 className="text-2xl font-semibold text-blue-400">All Conventions</h2>
                <button
                    onClick={toggleSortOrder}
                    className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 transition duration-300 ease-in-out shadow-md"
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
                        className="bg-blue-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-blue-700 transition duration-300 ease-in-out shadow-md"
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
                            const selectButtonClasses = `px-4 py-2 rounded-md font-semibold transition duration-300 ease-in-out ${currentConvention?.id === conv.id ? 'bg-blue-800 text-white' : 'bg-gray-600 text-gray-100 hover:bg-gray-700'}`;
                            return (
                                <li key={conv.id} className="flex flex-col sm:flex-row items-start sm:items-center justify-between bg-gray-900 p-3 rounded-md shadow-sm border border-gray-700">
                                    <div className="flex-grow">
                                        <span className="font-medium text-gray-100 block">{conv.name}</span>
                                        <span className="text-sm text-gray-300">
                                            {new Date(conv.startDate).toLocaleDateString()} - {new Date(conv.endDate).toLocaleDateString()}
                                        </span>
                                    </div>
                                    <div className="flex flex-col sm:flex-row gap-2 mt-3 sm:mt-0">
                                        <button
                                            onClick={() => {
                                                if (currentConvention?.id === conv.id) {
                                                    setCurrentConventionId(null);
                                                } else {
                                                    setCurrentConventionId(conv.id);
                                                }
                                            }}
                                            className={selectButtonClasses}
                                        >
                                            {currentConvention?.id === conv.id ? 'Selected (Deselect)' : 'Select'}
                                        </button>
                                        <button
                                            onClick={() => setEditingConvention(conv)}
                                            className="px-4 py-2 bg-yellow-600 text-white rounded-lg font-semibold hover:bg-yellow-700 transition duration-300 ease-in-out shadow-md"
                                            disabled={loading}
                                        >
                                            Edit
                                        </button>
                                        <button
                                            onClick={() => deleteConvention(conv)}
                                            className="px-4 py-2 bg-red-700 text-white rounded-lg font-semibold hover:bg-red-800 transition duration-300 ease-in-out shadow-md"
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
            <h2 className="text-2xl font-semibold text-blue-400 mb-4">Checked Out Games for {currentConvention?.name || 'Selected Convention'}</h2>
            {!currentConvention ? (
                <p className="text-gray-400">Please select a convention from the "All Conventions" tab to view its checked out games.</p>
            ) : checkedOutGames.length === 0 ? (
                <p className="text-gray-400">No games are currently checked out for this convention.</p>
            ) : (
                <div className="mt-4 scrollable-list bg-gray-700 p-3 border border-gray-600">
                    <ul className="space-y-3">
                        {checkedOutGames.map(convGame => {
                            if (!convGame || typeof convGame.id === 'undefined') {
                                return null;
                            }
                            const displayAverageRating = (typeof convGame?.averageRating === 'number') ? convGame.averageRating.toFixed(2) : 'N/A';
                            return (
                                <li key={convGame.id} className="flex flex-col sm:flex-row items-start sm:items-center gap-4 bg-gray-900 p-4 rounded-md shadow-sm border border-gray-700">
                                    <img src={convGame.thumbnail || `https://placehold.co/50x50/2d3748/cbd5e0?text=No+Img`} alt={convGame.name} className="w-12 h-12 object-cover rounded-md flex-shrink-0" />
                                    <div className="flex-grow">
                                        <span className="font-medium text-gray-100 block">
                                            <a href={`https://boardgamegeek.com/boardgame/${convGame.bggId}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline">
                                                {convGame.name}
                                            </a>
                                            <span className="text-sm text-gray-300">({convGame.ownerName})</span>
                                        </span>
                                        <p className="text-sm text-gray-300">Convention Checkouts: {convGame.conventionCheckoutCount || 0}</p>
                                        <p className="text-sm text-gray-300">Status (Convention): <span className="font-semibold text-red-400">Checked Out</span></p>
                                        <p className="text-sm text-gray-300 flex items-center">
                                            BGG Rating:
                                            <span className="ml-2 text-gray-300 text-xs font-semibold">
                                                {displayAverageRating}
                                            </span>
                                        </p>
                                    </div>
                                    <div className="flex flex-col sm:flex-row gap-2 mt-3 sm:mt-0">
                                        <button
                                            onClick={() => handleToggleAndFocus(convGame, currentConvention.id)}
                                            className="px-3 py-1 bg-green-600 text-white rounded-lg font-semibold text-xs hover:bg-green-700 transition duration-300 ease-in-out shadow-sm"
                                            disabled={loading}
                                        >
                                            Check In
                                        </button>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                </div>
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

    // Function to focus the appropriate search input based on the current page and clear its value
    const focusSearchInput = useCallback(() => {
        if (currentPage === 'home' && homeSearchInputRef.current) {
            homeSearchInputRef.current.focus();
        } else if (currentPage === 'library' && librarySearchInputRef.current) {
            librarySearchInputRef.current.focus();
        }
    }, [currentPage]);


    // Fetch games from BGG API - Modified to exclude expansions
    const fetchBggCollection = useCallback(async (username) => {
        // console.log(`[BGG Import] Fetching collection for username: ${username}`); // Removed for performance
        try {
            // Exclude expansions using the excludesubtype parameter
            const url = `https://boardgamegeek.com/xmlapi2/collection?username=${username}&stats=1&excludesubtype=boardgameexpansion`;
            const response = await retryFetch(url, {}, 5, 1000);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const text = await response.text();
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
            return newGames;
        } catch (error) {
            console.error(`[BGG Import] Error fetching BGG collection for ${username}:`, error);
            showMessage(`Failed to fetch collection for ${username}. ${error.message}. Please check the username or try again later.`, 'error');
            return [];
        }
    }, [showMessage, currentUser]); // Dependency on currentUser

    // Import games from BGG and save/update to Firestore
    const importGames = useCallback(async (owner1BggUsername, owner2BggUsername) => {
        if (!db || !currentUser) { // Check currentUser
            console.warn("[ImportGames] Firebase not initialized or currentUser missing.");
            showMessage("Please log in to import games.", 'error');
            return;
        }
        setLoading(true);
        let totalAdded = 0;
        let totalUpdated = 0;

        try {
            // Function to process games for a single owner
            const processOwnerGames = async (username) => {
                if (!username) return { added: 0, updated: 0 };

                // console.log(`[ImportGames] Processing games for owner: ${username}`); // Removed for performance
                const importedGames = await fetchBggCollection(username);

                if (importedGames.length === 0) {
                    // console.log(`[ImportGames] No games fetched for ${username}.`); // Removed for performance
                    return { added: 0, updated: 0 };
                }

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
                return { added: addedCount, updated: updatedCount };
            };

            // Process owner 1's games first
            if (owner1BggUsername) {
                const result1 = await processOwnerGames(owner1BggUsername);
                totalAdded += result1.added;
                totalUpdated += result1.updated;
                // console.log(`[ImportGames] Finished processing ${owner1BggUsername}. Added: ${result1.added}, Updated: ${result1.updated}.`); // Removed for performance
            }

            // Then process owner 2's games
            if (owner2BggUsername) {
                const result2 = await processOwnerGames(owner2BggUsername);
                totalAdded += result2.added;
                totalUpdated += result2.updated;
                // console.log(`[ImportGames] Finished processing ${owner2BggUsername}. Added: ${result2.added}, Updated: ${result2.updated}.`); // Removed for performance
            }

            if (totalAdded === 0 && totalUpdated === 0) {
                showMessage("No new games imported or updated. Please check usernames.", 'info');
            } else {
                showMessage(`Import complete. Added ${totalAdded} new games. Updated ${totalUpdated} existing games.`, 'info');
            }

        } catch (error) {
            console.error("[ImportGames] Error during import process:", error);
            showMessage("Error importing games. Please try again.", 'error');
        } finally {
            setLoading(false);
        }
    }, [db, currentUser, fetchBggCollection, showMessage, appId, games, removedGames]); // eslint-disable-line react-hooks/exhaustive-deps

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
            showMessage(`Convention "${name}" created successfully!`, 'info');
        }
        catch (error) {
            console.error("[CreateConvention] Error creating convention:", error);
            showMessage("Error creating convention. Please try again.", 'error');
        } finally {
            setLoading(false);
        }
    }, [db, currentUser, showMessage, appId]);

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
            showMessage(`Convention "${name}" updated successfully!`, 'info');
            setEditingConvention(null); // Close the edit modal
        } catch (error) {
            console.error("[UpdateConvention] Error updating convention:", error);
            showMessage("Error updating convention. Please try again.", 'error');
        } finally {
            setLoading(false);
        }
    }, [db, currentUser, showMessage, appId]);

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
                            showMessage(`Convention "${conventionToDelete.name}" deleted successfully.`, 'info');
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
    }, [db, currentUser, showMessage, currentConventionId, appId]);

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
            showMessage("Please select a Convention first from the \"All Conventions\" area.", 'info');
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
                // Removed showMessage for adding a game to a convention
                if (isGameInConvention) { // Only show message if removing
                    showMessage(successMessage, 'info');
                }
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

    }, [db, currentUser, showMessage, closeMessage, appId, conventions, games, focusSearchInput]); // eslint-disable-line react-hooks/exhaustive-deps

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
                showMessage("CSV exported successfully!", 'info');
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
    }, [db, currentConvention, showMessage, appId, games, removedGames, currentUser]); // eslint-disable-line react-hooks/exhaustive-deps

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

            showMessage(`"${gameToRemove.name} (${gameToRemove.ownerName})" has been moved to "Removed Games". Its historical records are preserved.`, 'info');
        } catch (error) {
            console.error("[RemoveGame] Error removing game from library:", error);
            showMessage("Error removing game from library. Please try again.", 'error');
        } finally {
            setLoading(false);
            focusSearchInput(); // Focus search input after operation
        }
    }, [db, currentUser, showMessage, appId, focusSearchInput]);

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

            showMessage(`"${gameToReAdd.name} (${gameToReAdd.ownerName})" has been re-added to the main library.`, 'info');
        } catch (error) {
            console.error("Error re-adding game to library:", error);
            showMessage("Error re-adding game to library. Please try again.", 'error');
        } finally {
            setLoading(false);
            focusSearchInput(); // Focus search input after operation
        }
    }, [db, currentUser, showMessage, appId, focusSearchInput]);

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
            showMessage(`"${gameData.name}" added to your library!`, 'info');
            setAddingCustomGame(false); // Close the modal
        } catch (error) {
            console.error("[AddCustomGame] Error adding custom game:", error);
            showMessage("Error adding custom game. Please try again.", 'error');
        } finally {
            setLoading(false);
            focusSearchInput(); // Focus search input after operation
        }
    }, [db, currentUser, showMessage, appId, focusSearchInput]);

    // Function to clear all games data (conventions are not deleted)
    const clearAllData = useCallback(async () => {
        if (!db || !currentUser) { // Check currentUser
            console.warn("[ClearAllData] Firebase not initialized or currentUser missing.");
            showMessage("Please log in to clear data.", 'error');
            return;
        }

        const confirmStep3 = async () => {
            setLoading(true);
            try {
                // Delete all games
                const gamesCollectionRef = collection(db, `artifacts/${appId}/public/data/games`);
                const gamesSnapshot = await getDocs(gamesCollectionRef);
                const gameDeletePromises = gamesSnapshot.docs.map(doc => deleteDoc(doc.ref));
                await Promise.all(gameDeletePromises);
                // console.log("[ClearAllData] All games deleted."); // Removed for performance

                // Conventions are NOT deleted as per user request
                showMessage("All game and checkout data has been cleared permanently.", 'info');
                setCurrentConventionId(null); // Deselect any active convention
            } catch (error) {
                console.error("[ClearAllData] Error clearing all data:", error);
                showMessage("Error clearing all data. Please try again.", 'error');
            } finally {
                setLoading(false);
                focusSearchInput(); // Focus search input after operation
            }
        };

        const confirmStep2 = () => {
            showMessage(
                "This will PERMANENTLY delete ALL game and checkout data. This action is irreversible. Are you absolutely sure?",
                'confirm',
                confirmStep3
            );
        };

        const confirmStep1 = () => {
            showMessage(
                "WARNING: Clearing all data will remove every game and its checkout records from your library. Proceed with caution.",
                'confirm',
                confirmStep2
            );
        };

        confirmStep1();
    }, [db, currentUser, showMessage, appId, setCurrentConventionId, focusSearchInput]);

    // NEW FUNCTION: Clear all checkout data (overall and convention-specific)
    const clearAllCheckoutData = useCallback(async () => {
        if (!db || !currentUser) {
            console.warn("[ClearAllCheckoutData] Firebase not initialized or currentUser missing.");
            showMessage("Please log in to clear checkout data.", 'error');
            return;
        }

        const confirmStep3 = async () => {
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

                showMessage("All checkout data has been cleared successfully!", 'info');
            } catch (error) {
                console.error("[ClearAllCheckoutData] Error clearing checkout data:", error);
                showMessage("Error clearing checkout data. Please try again.", 'error');
            } finally {
                setLoading(false);
                focusSearchInput(); // Focus search input after operation
            }
        };

        const confirmStep2 = () => {
            showMessage(
                "This will reset ALL game and convention checkout counts to zero. This action is irreversible for checkout data. Are you absolutely sure?",
                'confirm',
                confirmStep3
            );
        };

        const confirmStep1 = () => {
            showMessage(
                "WARNING: Clearing all checkout data will remove all checkout records from your library. Proceed with caution.",
                'confirm',
                confirmStep2
            );
        };

        confirmStep1();
    }, [db, currentUser, showMessage, appId, focusSearchInput]);


    return (
        <div className="min-h-screen bg-gray-900 text-gray-100 font-sans flex flex-col items-center p-4 sm:p-6">
            <style>
                {`
                html, body, #root { /* Ensure full height for proper min-h-screen behavior */
                    height: 100%;
                    margin: 0;
                    padding: 0;
                    overflow: auto;
                }
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
                body {
                    font-family: 'Inter', sans-serif;
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

            {/* Loading overlay for general app operations */}
            {loading && (
                <div className="fixed inset-0 bg-gray-800 bg-opacity-75 flex items-center justify-center z-50">
                    <div className="animate-spin rounded-full h-20 w-20 border-t-4 border-b-4 border-blue-400"></div>
                    <p className="ml-4 text-xl text-blue-300">Loading...</p>
                </div>
            )}

            <MessageBox message={message} type={messageType} onClose={closeMessage} onConfirm={confirmAction} />

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
                <>
                    <h1 className="text-4xl font-bold text-blue-400 mb-8 mt-4">DFW Gaming Village Library Manager</h1>
                    <p className="text-sm text-gray-300 mb-6">
                        Logged in as: <span className="font-mono text-blue-400 break-all">{currentUser.email}</span>
                        <span className="ml-4">User ID: <span className="font-mono text-blue-400 break-all">{currentUser.uid}</span></span>
                    </p>

                    {/* Navigation Buttons */}
                    <div className="mb-8 flex flex-col sm:flex-row justify-center items-center gap-4 w-full relative">
                        {/* Primary Navigation Row */}
                        <div className="flex flex-wrap justify-center gap-4 w-full sm:w-auto">
                            <button
                                onClick={() => setCurrentPage('home')}
                                className={`px-6 py-3 rounded-lg text-lg font-semibold transition duration-300 ease-in-out shadow-md
                                    ${currentPage === 'home' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-100 hover:bg-gray-600'}`}
                            >
                                Home ({currentConvention ? currentConvention.name : 'No Convention Selected'})
                            </button>
                            <button
                                onClick={() => setCurrentPage('checkedOutGames')}
                                className={`px-6 py-3 rounded-lg text-lg font-semibold transition duration-300 ease-in-out shadow-md
                                    ${currentPage === 'checkedOutGames' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-100 hover:bg-gray-600'}`}
                            >
                                Checked Out Games ({currentConvention ? currentConvention.games.filter(g => g.isCheckedOutAtConvention).length : 0})
                            </button>
                        </div>

                        {/* Secondary/Utility Navigation Column - Aligned top-right */}
                        <div className="flex flex-col items-stretch sm:items-end gap-2 mt-4 sm:mt-0 w-full sm:w-auto sm:absolute sm:top-0 sm:right-0">
                            <button
                                onClick={() => setCurrentPage('import')}
                                className={`px-4 py-2 rounded-lg text-sm font-semibold transition duration-300 ease-in-out shadow-md
                                    ${currentPage === 'import' ? 'bg-green-700 text-white' : 'bg-green-600 text-white hover:bg-green-700'}`}
                            >
                                Import Collections
                            </button>
                            <button
                                onClick={() => setCurrentPage('library')}
                                className={`px-4 py-2 rounded-lg text-sm font-semibold transition duration-300 ease-in-out shadow-md
                                    ${currentPage === 'library' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-100 hover:bg-gray-600'}`}
                            >
                                Combined Game Library
                            </button>
                            <button
                                onClick={() => setCurrentPage('allConventions')}
                                className={`px-4 py-2 rounded-lg text-sm font-semibold transition duration-300 ease-in-out shadow-md
                                    ${currentPage === 'allConventions' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-100 hover:bg-gray-600'}`}
                            >
                                All Conventions ({conventions.length})
                            </button>
                            <button
                                onClick={() => setCurrentPage('removed')}
                                className={`px-4 py-2 rounded-lg text-sm font-semibold transition duration-300 ease-in-out shadow-md
                                    ${currentPage === 'removed' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-100 hover:bg-gray-600'}`}
                            >
                                Games Removed From Library ({removedGames.length})
                            </button>
                            <button
                                onClick={logout}
                                className="px-4 py-2 bg-red-700 text-white rounded-lg text-sm font-semibold hover:bg-red-800 transition duration-300 ease-in-out shadow-md"
                            >
                                Logout
                            </button>
                        </div>
                    </div>

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
                            />
                        )}

                        {currentPage === 'import' && (
                            <ImportCollectionsPage
                                importGames={importGames}
                                loading={loading}
                                showMessage={showMessage}
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
                                clearAllData={clearAllData} // Pass clearAllData function
                                onAddCustomGame={() => setAddingCustomGame(true)} // New prop to open modal
                                librarySearchInputRef={librarySearchInputRef} // Pass ref
                                searchTerm={searchTerm} // Pass state value
                                setSearchTerm={setSearchTerm} // Pass state setter
                                clearAllCheckoutData={clearAllCheckoutData} // Pass new function
                                gamesByIdMap={gamesByIdMap} // Pass gamesByIdMap
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
                            />
                        )}

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
                </>
            )}
        </div>
    );
};

// Root component now wraps with FirebaseSetup and AuthProvider
const Root = () => (
    <FirebaseSetup>
        <AuthProvider>
            <App />
        </AuthProvider>
    </FirebaseSetup>
);

export default Root;
