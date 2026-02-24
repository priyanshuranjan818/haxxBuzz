const loginScreen = document.getElementById('login-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const passwordInput = document.getElementById('admin-password');
const btnLogin = document.getElementById('btn-login');
const loginMessage = document.getElementById('login-message');
const dashboardMessage = document.getElementById('dashboard-message');
const userList = document.getElementById('user-list');
const btnAddFunds = document.getElementById('btn-add-funds');
const addAmountInput = document.getElementById('add-amount');

let adminToken = null;
let selectedUser = null;

// Auth
btnLogin.addEventListener('click', async () => {
    const password = passwordInput.value;
    try {
        const res = await fetch('/api/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });

        const data = await res.json();

        if (data.success) {
            adminToken = data.token;
            loginScreen.classList.add('hidden');
            dashboardScreen.classList.remove('hidden');
            fetchUsers();
        } else {
            showMessage(loginMessage, data.error || 'Login failed', 'error');
        }
    } catch (err) {
        showMessage(loginMessage, 'Server error', 'error');
    }
});

// Fetch Users
async function fetchUsers() {
    try {
        const res = await fetch('/api/admin/users', {
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });

        if (res.status === 401) {
            // Token expired or invalid
            location.reload();
            return;
        }

        const users = await res.json();
        renderUsers(users);
    } catch (err) {
        showMessage(dashboardMessage, 'Error fetching users', 'error');
    }
}

function renderUsers(users) {
    userList.innerHTML = '';
    users.forEach(user => {
        const tr = document.createElement('tr');

        // Setup row click to select user
        tr.style.cursor = 'pointer';
        tr.className = selectedUser === user.username ? 'selected-row' : '';

        tr.innerHTML = `
            <td>${user.username}</td>
            <td>$${user.balance.toFixed(2)}</td>
            <td>
                <button class="action-btn secondary" style="padding: 5px 10px; margin: 0; font-size: 0.8rem;" onclick="selectUser('${user.username}')">Select</button>
            </td>
        `;
        userList.appendChild(tr);
    });
}

// Global function so onclick attribute works easily
window.selectUser = function (username) {
    selectedUser = username;
    btnAddFunds.disabled = false;
    btnAddFunds.textContent = `Add Funds to ${username}`;

    // Quick visual re-render hack without refetching for MVP
    const rows = userList.querySelectorAll('tr');
    rows.forEach(r => {
        if (r.innerHTML.includes(`<td>${username}</td>`)) {
            r.style.backgroundColor = 'var(--bg-card-hover)';
        } else {
            r.style.backgroundColor = 'transparent';
        }
    });
};

// Add Funds
btnAddFunds.addEventListener('click', async () => {
    if (!selectedUser) return;
    const amount = parseFloat(addAmountInput.value);

    if (isNaN(amount) || amount <= 0) {
        showMessage(dashboardMessage, 'Please enter a valid amount', 'error');
        return;
    }

    try {
        const res = await fetch('/api/admin/add-funds', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${adminToken}`
            },
            body: JSON.stringify({ username: selectedUser, amount })
        });

        const data = await res.json();

        if (data.success) {
            showMessage(dashboardMessage, `Successfully added $${amount} to ${selectedUser}. New balance: $${data.newBalance.toFixed(2)}`, 'success');
            addAmountInput.value = '';
            fetchUsers(); // Refresh list
        } else {
            showMessage(dashboardMessage, data.error || 'Failed to add funds', 'error');
        }
    } catch (err) {
        showMessage(dashboardMessage, 'Server error', 'error');
    }
});

function showMessage(element, msg, type) {
    element.textContent = msg;
    element.className = `message ${type}`;
    element.classList.remove('hidden');
    setTimeout(() => element.classList.add('hidden'), 3000);
}
