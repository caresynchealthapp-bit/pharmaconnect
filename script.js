
/* ============================================================================
   PHARMACONNECT - MAIN LANDING CONTROLLER & STRICT MULTI-TENANT AUTH
   ============================================================================ */
const SUPABASE_URL = 'https://juobkaftyrzlxbviudpy.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_qdME8AYk9rz5B4FHs4Eb1g_0vvhN73v';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const STOCK_PHARMACY_IMAGES = [
    'https://images.unsplash.com/photo-1586015555751-63bb77f4322a?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1576602976047-174e57a47881?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1631549916768-4119b2e5f926?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1587854692152-cbe660dbde88?auto=format&fit=crop&w=800&q=80'
];

let pharmaciesList = [];
let selectedPharmacy = null;
let selectedRole = null;

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', async () => {
    setupEventListeners();
    await loadPharmacies();
});

function setupEventListeners() {
    const searchInput = document.getElementById('pharmacy-search-input');
    const clearBtn = document.getElementById('clear-search-btn');

    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.trim();
            
            // Only try to toggle the custom clear button if it exists in the HTML
            if (clearBtn) {
                clearBtn.classList.toggle('hidden', query.length === 0);
            }
            
            // Render the tiles based on the search query
            renderPharmacyTiles(query);
        });
    }

    if (clearBtn && searchInput) {
        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            clearBtn.classList.add('hidden');
            renderPharmacyTiles('');
            searchInput.focus();
        });
    }

    const registerForm = document.getElementById('register-pharmacy-form');
    if (registerForm) {
        registerForm.addEventListener('submit', handleRegisterPharmacy);
    }

    const roleLoginForm = document.getElementById('role-login-form');
    if (roleLoginForm) {
        roleLoginForm.addEventListener('submit', handleRoleLogin);
    }
}

// ==================== LOAD PHARMACIES FROM SUPABASE ====================
async function loadPharmacies() {
    try {
        const { data, error } = await supabaseClient
            .from('pharmacies')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;
        pharmaciesList = data || [];
    } catch (err) {
        console.error('Supabase fetch error:', err.message);
        showToast(`Database Read Error: ${err.message}`, 'error');
        pharmaciesList = [];
    }

    renderPharmacyTiles('');
}

// ==================== RENDER PHARMACY TILES ====================
function renderPharmacyTiles(searchQuery = '') {
    const grid = document.getElementById('pharmacy-tiles-grid');
    const emptyState = document.getElementById('no-results-state');
    const countBadge = document.getElementById('pharmacy-count-badge');

    const normalizedQuery = searchQuery.toLowerCase();

    const filtered = pharmaciesList.filter((item) => {
        return (
            (item.pharmacy_name || '').toLowerCase().includes(normalizedQuery) ||
            (item.city || '').toLowerCase().includes(normalizedQuery) ||
            (item.address || '').toLowerCase().includes(normalizedQuery) ||
            (item.license_no || '').toLowerCase().includes(normalizedQuery)
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

// ==================== REGISTER NEW PHARMACY ====================
async function handleRegisterPharmacy(e) {
    e.preventDefault();

    const errorBox = document.getElementById('register-error-box');
    errorBox.classList.add('hidden');

    const pharmacyName = document.getElementById('reg-pharmacy-name').value.trim();
    const licenseNo = document.getElementById('reg-license-no').value.trim();
    const phone = document.getElementById('reg-phone').value.trim();
    const operatingHours = document.getElementById('reg-hours').value;
    const city = document.getElementById('reg-city').value.trim();
    const address = document.getElementById('reg-address').value.trim();
    const latitude = document.getElementById('reg-lat').value.trim() || '6.7951';
    const longitude = document.getElementById('reg-lng').value.trim() || '79.9009';
    const customImage = document.getElementById('reg-image-url').value.trim();
    const adminEmail = document.getElementById('reg-admin-email').value.trim();
    const adminUsername = document.getElementById('reg-admin-username').value.trim();
    const adminPassword = document.getElementById('reg-admin-password').value;
    const confirmPassword = document.getElementById('reg-admin-confirm').value;

    if (adminPassword !== confirmPassword) {
        showFormError(errorBox, 'Passwords do not match! Please re-enter.');
        return;
    }

    const submitBtn = document.getElementById('btn-submit-register');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving to Database...';

    const randomStockImage = STOCK_PHARMACY_IMAGES[Math.floor(Math.random() * STOCK_PHARMACY_IMAGES.length)];

    try {
        let authUserId = null;
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

        if (authError) {
            if (!authError.message.toLowerCase().includes('already registered')) {
                throw new Error(`Supabase Auth Error: ${authError.message}`);
            }
        } else {
            authUserId = authData?.user?.id || null;
        }

        const { data: insertedRow, error: dbError } = await supabaseClient
            .from('pharmacies')
            .insert([{
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
                admin_user_id: authUserId
            }])
            .select()
            .single();

        if (dbError) {
            throw new Error(`Database Table Error: ${dbError.message}`);
        }

        pharmaciesList.unshift(insertedRow);
        document.getElementById('register-pharmacy-form').reset();
        renderPharmacyTiles('');
        navigateTo('home');
        showToast(`${pharmacyName} successfully saved to database!`);

    } catch (err) {
        console.error('Registration failed:', err);
        showFormError(errorBox, err.message);
        showToast(err.message, 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i> Complete Registration';
    }
}

function showFormError(element, message) {
    element.textContent = message;
    element.classList.remove('hidden');
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

    gpsBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Acquiring GPS...';
    statusText.textContent = 'Please click "Allow" on your browser location prompt...';

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const lat = position.coords.latitude.toFixed(5);
            const lng = position.coords.longitude.toFixed(5);
            latInput.value = lat;
            lngInput.value = lng;
            gpsBtn.innerHTML = '<i class="fa-solid fa-check"></i> Real GPS Locked';
            statusText.textContent = `Live device coordinates captured: (${lat}, ${lng})`;
            showToast('Live GPS coordinates captured!');
        },
        (err) => {
            gpsBtn.innerHTML = '<i class="fa-solid fa-location-crosshairs"></i> Detect Current GPS Location';
            statusText.textContent = `Browser blocked GPS (${err.message}). You can type coordinates or allow location in your browser address bar.`;
            showToast('Location permission blocked by browser. Enter manually or allow permission.', 'error');
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

// ==================== PHARMACY PORTAL & STRICT TENANT ROLE LOGIN ====================
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

function openRoleLogin(roleName) {
    if (!selectedPharmacy) return;
    selectedRole = roleName;

    document.getElementById('login-error-box').classList.add('hidden');
    document.getElementById('login-pharmacy-badge').textContent = selectedPharmacy.pharmacy_name;
    document.getElementById('login-role-title').textContent = `${roleName} Login`;

    const roleIconBox = document.getElementById('login-role-icon');
    const hintText = document.getElementById('login-hint-text');

    if (roleName === 'Admin') {
        roleIconBox.className = 'login-role-icon admin-accent';
        roleIconBox.innerHTML = '<i class="fa-solid fa-user-tie"></i>';
        hintText.textContent = `Restricted to ${selectedPharmacy.pharmacy_name} Master Admin (${selectedPharmacy.admin_username}). Other pharmacy credentials will be rejected.`;
    } else if (roleName === 'Cashier') {
        roleIconBox.className = 'login-role-icon cashier-accent';
        roleIconBox.innerHTML = '<i class="fa-solid fa-cash-register"></i>';
        hintText.textContent = `Enter your Cashier username & password assigned by the ${selectedPharmacy.pharmacy_name} Admin.`;
    } else {
        roleIconBox.className = 'login-role-icon grn-accent';
        roleIconBox.innerHTML = '<i class="fa-solid fa-truck-ramp-box"></i>';
        hintText.textContent = `Enter your GRN System username & password assigned by the ${selectedPharmacy.pharmacy_name} Admin (or Master Admin login).`;
    }

    navigateTo('login');
}
// ==================== PHARMACY PORTAL & STRICT TENANT ROLE LOGIN ====================

// Helper to encrypt password before checking the database
function encryptPassword(pwd) {
    const SECRET_KEY = "PC_SECURE_2026_";
    return btoa(SECRET_KEY + pwd).split('').reverse().join('');
}

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

function openRoleLogin(roleName) {
    if (!selectedPharmacy) return;
    selectedRole = roleName;

    document.getElementById('login-error-box').classList.add('hidden');
    document.getElementById('login-pharmacy-badge').textContent = selectedPharmacy.pharmacy_name;
    document.getElementById('login-role-title').textContent = `${roleName} Login`;

    const roleIconBox = document.getElementById('login-role-icon');
    const hintText = document.getElementById('login-hint-text');

    if (roleName === 'Admin') {
        roleIconBox.className = 'login-role-icon admin-accent';
        roleIconBox.innerHTML = '<i class="fa-solid fa-user-tie"></i>';
        hintText.textContent = `Restricted to ${selectedPharmacy.pharmacy_name} Master Admin (${selectedPharmacy.admin_username}). Other pharmacy credentials will be rejected.`;
    } else if (roleName === 'Cashier') {
        roleIconBox.className = 'login-role-icon cashier-accent';
        roleIconBox.innerHTML = '<i class="fa-solid fa-cash-register"></i>';
        hintText.textContent = `Enter your Cashier username & password assigned by the ${selectedPharmacy.pharmacy_name} Admin.`;
    } else {
        roleIconBox.className = 'login-role-icon grn-accent';
        roleIconBox.innerHTML = '<i class="fa-solid fa-truck-ramp-box"></i>';
        hintText.textContent = `Enter your GRN System username & password assigned by the ${selectedPharmacy.pharmacy_name} Admin (or Master Admin login).`;
    }

    navigateTo('login');
}

async function handleRoleLogin(e) {
    e.preventDefault();
    if (!selectedPharmacy || !selectedRole) return;

    const enteredUser = document.getElementById('login-username').value.trim();
    const enteredPass = document.getElementById('login-password').value.trim();
    const loginBtn = document.getElementById('btn-role-login');
    const errorBox = document.getElementById('login-error-box');
    errorBox.classList.add('hidden');

    loginBtn.disabled = true;
    loginBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying Tenant Credentials...';

    try {
        const isMasterAdminUser =
            enteredUser.toLowerCase() === (selectedPharmacy.admin_username || '').toLowerCase() ||
            enteredUser.toLowerCase() === (selectedPharmacy.admin_email || '').toLowerCase();

        // 1. ADMIN PORTAL LOGIN
        if (selectedRole === 'Admin') {
            if (!isMasterAdminUser) {
                throw new Error(`Access Denied: "${enteredUser}" is not the registered Admin for ${selectedPharmacy.pharmacy_name}.`);
            }

            const { data, error } = await supabaseClient.auth.signInWithPassword({
                email: selectedPharmacy.admin_email,
                password: enteredPass
            });

            if (error || !data.user) {
                throw new Error(`Invalid Admin password for ${selectedPharmacy.pharmacy_name}.`);
            }

            saveActivePortalSession({
                pharmacy_id: selectedPharmacy.id,
                pharmacy_name: selectedPharmacy.pharmacy_name,
                role: 'admin',
                staff_name: selectedPharmacy.admin_username,
                counter_name: 'Master Admin Console'
            });

            showToast(`Authenticated! Opening ${selectedPharmacy.pharmacy_name} Admin Portal...`);
            setTimeout(() => {
                window.location.href = `admin.html?pharmacy_id=${encodeURIComponent(selectedPharmacy.id)}`;
            }, 500);
            return;
        }

        // 2. GRN SYSTEM OR CASHIER LOGIN (WITH ENCRYPTION SUPPORT)
        const targetRoleKey = selectedRole === 'GRN System' ? 'grn' : 'cashier';

        // Check if the password matches either the new Encrypted format OR your old plain-text test accounts
        const { data: staffMatch, error: staffError } = await supabaseClient
            .from('pharmacy_staff')
            .select('*')
            .eq('pharmacy_id', selectedPharmacy.id)
            .eq('role', targetRoleKey)
            .ilike('username', enteredUser)
            .in('password', [enteredPass, encryptPassword(enteredPass)])
            .eq('is_active', true)
            .maybeSingle();

        if (staffError) {
            throw new Error(`Staff verification error: ${staffError.message}`);
        }

        let authenticatedStaff = staffMatch;

        if (!authenticatedStaff && isMasterAdminUser) {
            const { data: adminAuth, error: adminErr } = await supabaseClient.auth.signInWithPassword({
                email: selectedPharmacy.admin_email,
                password: enteredPass
            });
            if (!adminErr && adminAuth?.user) {
                authenticatedStaff = {
                    full_name: `${selectedPharmacy.admin_username} (Admin)`,
                    username: selectedPharmacy.admin_username,
                    counter_name: targetRoleKey === 'grn' ? 'Master GRN Desk' : 'Master POS Counter'
                };
            }
        }

        if (!authenticatedStaff) {
            throw new Error(
                `Access Denied: Invalid ${selectedRole} credentials for ${selectedPharmacy.pharmacy_name}.`
            );
        }

        saveActivePortalSession({
            pharmacy_id: selectedPharmacy.id,
            pharmacy_name: selectedPharmacy.pharmacy_name,
            role: targetRoleKey,
            staff_name: authenticatedStaff.full_name,
            username: authenticatedStaff.username,
            counter_name: authenticatedStaff.counter_name || 'Main Desk'
        });

        if (targetRoleKey === 'grn') {
            showToast(`Welcome ${authenticatedStaff.full_name}! Launching GRN System...`);
            setTimeout(() => {
                window.location.href = `grn.html?pharmacy_id=${encodeURIComponent(selectedPharmacy.id)}`;
            }, 500);
        } else {
            showToast(`Welcome ${authenticatedStaff.full_name}! Launching ${authenticatedStaff.counter_name || 'POS'}...`);
            setTimeout(() => {
                window.location.href = `cashier.html?pharmacy_id=${encodeURIComponent(selectedPharmacy.id)}`;
            }, 500);
        }

    } catch (err) {
        errorBox.textContent = err.message;
        errorBox.classList.remove('hidden');
        showToast(err.message, 'error');
    } finally {
        loginBtn.disabled = false;
        loginBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Sign In to Workspace';
    }
}
function saveActivePortalSession(sessionObj) {
    sessionStorage.setItem('pc_active_session', JSON.stringify({
        ...sessionObj,
        authenticated_at: new Date().toISOString()
    }));
}

// ==================== SPA VIEW NAVIGATION ====================
function navigateTo(viewName) {
    document.querySelectorAll('.view-section').forEach((sec) => sec.classList.remove('active'));

    if (viewName === 'home') {
        document.getElementById('view-home').classList.add('active');
    } else if (viewName === 'register') {
        document.getElementById('register-error-box').classList.add('hidden');
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
    }, 4500);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}