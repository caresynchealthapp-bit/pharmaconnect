/* ============================================================================
   PHARMACONNECT - FRONTEND CONTROLLER & SUPABASE INTEGRATION
   ============================================================================ */

// 1. SUPABASE CONFIGURATION
// Replace these two placeholders with your actual Supabase Project URL & Anon Key
const SUPABASE_URL = 'YOUR_SUPABASE_PROJECT_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

// Check if real Supabase credentials are configured
const isSupabaseConfigured = 
    SUPABASE_URL !== 'https://juobkaftyrzlxbviudpy.supabase.co' && 
    SUPABASE_ANON_KEY !== 'sb_publishable_qdME8AYk9rz5B4FHs4Eb1g_0vvhN73v';

let supabaseClient = null;
if (isSupabaseConfigured && window.supabase) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// Default Stock Images for Registered Pharmacies
const STOCK_PHARMACY_IMAGES = [
    'https://images.unsplash.com/photo-1586015555751-63bb77f4322a?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1576602976047-174e57a47881?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1631549916768-4119b2e5f926?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1587854692152-cbe660dbde88?auto=format&fit=crop&w=800&q=80'
];

// Initial Seed Pharmacies (Used when running locally before Supabase table is connected)
const INITIAL_PHARMACIES = [
    {
        id: 'pharm-101',
        pharmacy_name: 'MediCare Central Pharmacy',
        license_no: 'PH-SL-2026-104',
        city: 'Moratuwa',
        address: 'No. 245, Galle Road, Moratuwa',
        latitude: '6.7951',
        longitude: '79.9009',
        phone: '+94 11 264 5512',
        operating_hours: '24/7 Open',
        admin_email: 'admin@medicare.lk',
        admin_username: 'medicare_admin',
        admin_password: 'password123',
        image_url: STOCK_PHARMACY_IMAGES[0]
    },
    {
        id: 'pharm-102',
        pharmacy_name: 'LifeLine Health & Pharma',
        license_no: 'PH-SL-2026-289',
        city: 'Colombo 03',
        address: 'No. 88, Duplication Road, Kollupitiya',
        latitude: '6.9044',
        longitude: '79.8540',
        phone: '+94 11 257 8900',
        operating_hours: '8:00 AM - 10:00 PM',
        admin_email: 'admin@lifeline.lk',
        admin_username: 'lifeline_admin',
        admin_password: 'password123',
        image_url: STOCK_PHARMACY_IMAGES[1]
    },
    {
        id: 'pharm-103',
        pharmacy_name: 'CityCare Chemist & Druggist',
        license_no: 'PH-SL-2026-512',
        city: 'Kandy',
        address: 'No. 19, Peradeniya Road, Kandy',
        latitude: '7.2906',
        longitude: '80.6337',
        phone: '+94 81 222 4410',
        operating_hours: '8:00 AM - 9:00 PM',
        admin_email: 'admin@citycare.lk',
        admin_username: 'citycare_admin',
        admin_password: 'password123',
        image_url: STOCK_PHARMACY_IMAGES[2]
    }
];

// Application State
let pharmaciesList = [];
let selectedPharmacy = null;
let selectedRole = null;

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', async () => {
    await loadPharmacies();
    setupEventListeners();
});

function setupEventListeners() {
    // Search Bar Input Listener
    const searchInput = document.getElementById('pharmacy-search-input');
    const clearBtn = document.getElementById('clear-search-btn');

    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim();
        clearBtn.classList.toggle('hidden', query.length === 0);
        renderPharmacyTiles(query);
    });

    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearBtn.classList.add('hidden');
        renderPharmacyTiles('');
        searchInput.focus();
    });

    // Registration Form Submission
    const registerForm = document.getElementById('register-pharmacy-form');
    registerForm.addEventListener('submit', handleRegisterPharmacy);

    // Role Login Form Submission
    const roleLoginForm = document.getElementById('role-login-form');
    roleLoginForm.addEventListener('submit', handleRoleLogin);
}

// ==================== DATA FETCHING (SUPABASE + LOCAL FALLBACK) ====================
async function loadPharmacies() {
    if (supabaseClient) {
        try {
            const { data, error } = await supabaseClient
                .from('pharmacies')
                .select('*')
                .order('created_at', { ascending: false });

            if (error) throw error;
            pharmaciesList = data || [];
        } catch (err) {
            console.error('Supabase fetch error, using local storage:', err.message);
            loadFromLocalStorage();
        }
    } else {
        loadFromLocalStorage();
    }

    renderPharmacyTiles('');
}

function loadFromLocalStorage() {
    const saved = localStorage.getItem('pharmaconnect_pharmacies');
    if (saved) {
        pharmaciesList = JSON.parse(saved);
    } else {
        pharmaciesList = [...INITIAL_PHARMACIES];
        localStorage.setItem('pharmaconnect_pharmacies', JSON.stringify(pharmaciesList));
    }
}

function saveToLocalStorage() {
    localStorage.setItem('pharmaconnect_pharmacies', JSON.stringify(pharmaciesList));
}

// ==================== RENDER PHARMACY TILES ON FRONT PAGE ====================
function renderPharmacyTiles(searchQuery = '') {
    const grid = document.getElementById('pharmacy-tiles-grid');
    const emptyState = document.getElementById('no-results-state');
    const countBadge = document.getElementById('pharmacy-count-badge');

    const normalizedQuery = searchQuery.toLowerCase();

    const filtered = pharmaciesList.filter((item) => {
        return (
            item.pharmacy_name.toLowerCase().includes(normalizedQuery) ||
            item.city.toLowerCase().includes(normalizedQuery) ||
            item.address.toLowerCase().includes(normalizedQuery) ||
            item.license_no.toLowerCase().includes(normalizedQuery)
        );
    });

    countBadge.textContent = `${filtered.length} ${filtered.length === 1 ? 'Pharmacy' : 'Pharmacies'}`;
    grid.innerHTML = '';

    if (filtered.length === 0) {
        grid.classList.add('hidden');
        emptyState.classList.remove('hidden');
        return;
    }

    grid.classList.remove('hidden');
    emptyState.classList.add('hidden');

    filtered.forEach((pharmacy) => {
        const card = document.createElement('div');
        card.className = 'pharmacy-tile';
        card.onclick = () => openPharmacyPortal(pharmacy.id);

        const coverImg = pharmacy.image_url || STOCK_PHARMACY_IMAGES[0];

        card.innerHTML = `
            <div class="tile-image-box">
                <img src="${escapeHtml(coverImg)}" alt="${escapeHtml(pharmacy.pharmacy_name)}" onerror="this.src='${STOCK_PHARMACY_IMAGES[0]}'">
                <span class="tile-hours-badge"><i class="fa-regular fa-clock"></i> ${escapeHtml(pharmacy.operating_hours)}</span>
                <span class="tile-license-badge">${escapeHtml(pharmacy.license_no)}</span>
            </div>
            <div class="tile-content">
                <h3 class="tile-title">${escapeHtml(pharmacy.pharmacy_name)}</h3>
                <div class="tile-meta">
                    <span><i class="fa-solid fa-location-dot"></i> ${escapeHtml(pharmacy.address)}, ${escapeHtml(pharmacy.city)}</span>
                    <span><i class="fa-solid fa-phone"></i> ${escapeHtml(pharmacy.phone)}</span>
                </div>
                <div class="tile-footer">
                    <span>Open Pharmacy Workspace</span>
                    <i class="fa-solid fa-arrow-right"></i>
                </div>
            </div>
        `;
        grid.appendChild(card);
    });
}

// ==================== REGISTER NEW PHARMACY (WITH SUPABASE AUTH) ====================
async function handleRegisterPharmacy(e) {
    e.preventDefault();

    const pharmacyName = document.getElementById('reg-pharmacy-name').value.trim();
    const licenseNo = document.getElementById('reg-license-no').value.trim();
    const phone = document.getElementById('reg-phone').value.trim();
    const operatingHours = document.getElementById('reg-hours').value;
    const city = document.getElementById('reg-city').value.trim();
    const address = document.getElementById('reg-address').value.trim();
    const latitude = document.getElementById('reg-lat').value.trim() || '6.9271';
    const longitude = document.getElementById('reg-lng').value.trim() || '79.8612';
    const customImage = document.getElementById('reg-image-url').value.trim();
    const adminEmail = document.getElementById('reg-admin-email').value.trim();
    const adminUsername = document.getElementById('reg-admin-username').value.trim();
    const adminPassword = document.getElementById('reg-admin-password').value;
    const confirmPassword = document.getElementById('reg-admin-confirm').value;

    if (adminPassword !== confirmPassword) {
        showToast('Passwords do not match! Please check again.', 'error');
        return;
    }

    const submitBtn = document.getElementById('btn-submit-register');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Registering Pharmacy...';

    const randomStockImage = STOCK_PHARMACY_IMAGES[Math.floor(Math.random() * STOCK_PHARMACY_IMAGES.length)];

    const newPharmacyRecord = {
        id: 'pharm-' + Date.now(),
        pharmacy_name: pharmacyName,
        license_no: licenseNo,
        phone: phone,
        operating_hours: operatingHours,
        city: city,
        address: address,
        latitude: latitude,
        longitude: longitude,
        image_url: customImage || randomStockImage,
        admin_email: adminEmail,
        admin_username: adminUsername,
        admin_password: adminPassword
    };

    try {
        if (supabaseClient) {
            // 1. Built-in Supabase Auth Sign Up for Master Admin
            const { data: authData, error: authError } = await supabaseClient.auth.signUp({
                email: adminEmail,
                password: adminPassword,
                options: {
                    data: {
                        username: adminUsername,
                        pharmacy_name: pharmacyName,
                        role: 'admin'
                    }
                }
            });

            if (authError) throw authError;

            // 2. Insert Pharmacy details into Supabase `pharmacies` table
            const { data: insertedData, error: dbError } = await supabaseClient
                .from('pharmacies')
                .insert([{
                    pharmacy_name: newPharmacyRecord.pharmacy_name,
                    license_no: newPharmacyRecord.license_no,
                    phone: newPharmacyRecord.phone,
                    operating_hours: newPharmacyRecord.operating_hours,
                    city: newPharmacyRecord.city,
                    address: newPharmacyRecord.address,
                    latitude: newPharmacyRecord.latitude,
                    longitude: newPharmacyRecord.longitude,
                    image_url: newPharmacyRecord.image_url,
                    admin_email: newPharmacyRecord.admin_email,
                    admin_username: newPharmacyRecord.admin_username,
                    admin_user_id: authData?.user?.id || null
                }])
                .select()
                .single();

            if (dbError) throw dbError;
            pharmaciesList.unshift(insertedData);
        } else {
            // Local Storage Fallback Mode
            pharmaciesList.unshift(newPharmacyRecord);
            saveToLocalStorage();
        }

        // Reset form, update front-page tiles, and return to home
        document.getElementById('register-pharmacy-form').reset();
        renderPharmacyTiles('');
        navigateTo('home');
        showToast(`${pharmacyName} registered and added to directory!`);

    } catch (err) {
        console.error('Registration error:', err);
        showToast(err.message || 'Failed to register pharmacy.', 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i> Complete Registration';
    }
}

// ==================== GEOLOCATION DETECTOR ====================
function detectLocation() {
    const statusText = document.getElementById('gps-status-text');
    const latInput = document.getElementById('reg-lat');
    const lngInput = document.getElementById('reg-lng');
    const gpsBtn = document.getElementById('btn-detect-gps');

    if (!navigator.geolocation) {
        showToast('Geolocation is not supported by your browser.', 'error');
        return;
    }

    gpsBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Acquiring Satellite Lock...';
    statusText.textContent = 'Requesting location permission from browser...';

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const lat = position.coords.latitude.toFixed(5);
            const lng = position.coords.longitude.toFixed(5);
            latInput.value = lat;
            lngInput.value = lng;
            gpsBtn.innerHTML = '<i class="fa-solid fa-check"></i> GPS Coordinates Locked';
            statusText.textContent = `Coordinates captured successfully (${lat}, ${lng}).`;
            showToast('Pharmacy GPS coordinates captured!');
        },
        (error) => {
            // Fallback coordinates if user denies browser prompt during demo
            latInput.value = '6.79510';
            lngInput.value = '79.90090';
            gpsBtn.innerHTML = '<i class="fa-solid fa-location-crosshairs"></i> Detect Current GPS Location';
            statusText.textContent = 'Browser GPS blocked; populated default demo coordinates (6.79510, 79.90090).';
            showToast('Populated default coordinates (GPS permission declined).');
        }
    );
}

// ==================== OPEN SPECIFIC PHARMACY PORTAL (3 TILES) ====================
function openPharmacyPortal(pharmacyId) {
    const found = pharmaciesList.find((p) => String(p.id) === String(pharmacyId));
    if (!found) return;

    selectedPharmacy = found;

    document.getElementById('portal-pharmacy-license').textContent = `REG: ${found.license_no}`;
    document.getElementById('portal-pharmacy-name').textContent = found.pharmacy_name;
    document.querySelector('#portal-pharmacy-location span').textContent = 
        `${found.address}, ${found.city} • ${found.operating_hours}`;

    navigateTo('portal');
}

// ==================== OPEN ROLE LOGIN PAGE (ADMIN / CASHIER / GRN) ====================
function openRoleLogin(roleName) {
    if (!selectedPharmacy) return;
    selectedRole = roleName;

    const roleTitle = document.getElementById('login-role-title');
    const pharmacyBadge = document.getElementById('login-pharmacy-badge');
    const roleIconBox = document.getElementById('login-role-icon');
    const hintText = document.getElementById('login-hint-text');

    pharmacyBadge.textContent = selectedPharmacy.pharmacy_name;
    roleTitle.textContent = `${roleName} Login`;

    // Customize icon and accent color based on which of the 3 tiles was clicked
    if (roleName === 'Admin') {
        roleIconBox.className = 'login-role-icon admin-accent';
        roleIconBox.innerHTML = '<i class="fa-solid fa-user-tie"></i>';
        hintText.textContent = `Log in with the Master Admin username (${selectedPharmacy.admin_username}) and password created during registration.`;
    } else if (roleName === 'Cashier') {
        roleIconBox.className = 'login-role-icon cashier-accent';
        roleIconBox.innerHTML = '<i class="fa-solid fa-cash-register"></i>';
        hintText.textContent = `First-time access: Sign in using the Pharmacy Admin credentials (${selectedPharmacy.admin_username}). Separate Cashier logins can be configured inside the Admin portal.`;
    } else {
        roleIconBox.className = 'login-role-icon grn-accent';
        roleIconBox.innerHTML = '<i class="fa-solid fa-truck-ramp-box"></i>';
        hintText.textContent = `First-time access: Sign in using the Pharmacy Admin credentials (${selectedPharmacy.admin_username}). Dedicated GRN staff credentials can be set inside the Admin portal.`;
    }

    document.getElementById('role-login-form').reset();
    navigateTo('login');
}

// ==================== HANDLE ROLE AUTHENTICATION ====================
async function handleRoleLogin(e) {
    e.preventDefault();
    if (!selectedPharmacy || !selectedRole) return;

    const enteredUser = document.getElementById('login-username').value.trim();
    const enteredPass = document.getElementById('login-password').value;
    const loginBtn = document.getElementById('btn-role-login');

    loginBtn.disabled = true;
    loginBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying Credentials...';

    try {
        let isAuthenticated = false;

        if (supabaseClient && enteredUser.includes('@')) {
            // Authenticate via Supabase Built-in Auth if email is used
            const { data, error } = await supabaseClient.auth.signInWithPassword({
                email: enteredUser,
                password: enteredPass
            });
            if (error) throw error;
            if (data.user) isAuthenticated = true;
        } else {
            // Verify against the Pharmacy's Admin Username / Email & Password
            const matchesUsername = 
                enteredUser.toLowerCase() === (selectedPharmacy.admin_username || '').toLowerCase() ||
                enteredUser.toLowerCase() === (selectedPharmacy.admin_email || '').toLowerCase();

            const matchesPassword = enteredPass === selectedPharmacy.admin_password;

            if (matchesUsername && matchesPassword) {
                isAuthenticated = true;
            }
        }

        if (isAuthenticated) {
            showToast(`Welcome to ${selectedPharmacy.pharmacy_name} — ${selectedRole} Portal!`);
        } else {
            showToast('Invalid Admin username or password for this pharmacy.', 'error');
        }
    } catch (err) {
        showToast(err.message || 'Authentication failed.', 'error');
    } finally {
        loginBtn.disabled = false;
        loginBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Sign In to Workspace';
    }
}

// ==================== SPA VIEW NAVIGATION ====================
function navigateTo(viewName) {
    document.querySelectorAll('.view-section').forEach((sec) => sec.classList.remove('active'));

    if (viewName === 'home') {
        document.getElementById('view-home').classList.add('active');
    } else if (viewName === 'register') {
        document.getElementById('view-register').classList.add('active');
    } else if (viewName === 'portal') {
        document.getElementById('view-pharmacy-portal').classList.add('active');
    } else if (viewName === 'login') {
        document.getElementById('view-role-login').classList.add('active');
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function scrollToAbout(event) {
    event.preventDefault();
    navigateTo('home');
    setTimeout(() => {
        const aboutEl = document.getElementById('about-section');
        if (aboutEl) aboutEl.scrollIntoView({ behavior: 'smooth' });
    }, 100);
}

// ==================== UTILITIES ====================
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <i class="fa-solid ${type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-check'}"></i>
        <span>${escapeHtml(message)}</span>
    `;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}