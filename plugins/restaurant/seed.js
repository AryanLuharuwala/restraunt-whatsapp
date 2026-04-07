#!/usr/bin/env node
/**
 * Seed script — run once to populate a demo menu and config.
 * Usage: node plugins/restaurant/seed.js
 */

const db = require('./db');

// Config
db.saveConfig({
    name: 'My Restaurant',
    currency: '₹',
    branches: ['main'],
    defaultBranch: 'main',
    adminNumbers: [],   // Add restaurant owner's number here
    paymentNote: 'Please send payment via WhatsApp Pay to confirm your order.',
});

// Demo menu
db.saveMenu({
    categories: [
        {
            id: 'starters',
            name: '🥗 Starters',
            items: [
                { id: 'paneer-tikka', name: 'Paneer Tikka', price: 220, desc: 'Grilled cottage cheese with spices', available: true },
                { id: 'veg-spring-roll', name: 'Veg Spring Roll', price: 180, desc: 'Crispy rolls with vegetable filling', available: true },
                { id: 'chicken-65', name: 'Chicken 65', price: 260, desc: 'Spicy deep-fried chicken', available: true },
            ]
        },
        {
            id: 'mains',
            name: '🍛 Main Course',
            items: [
                { id: 'butter-chicken', name: 'Butter Chicken', price: 320, desc: 'Creamy tomato curry with chicken', available: true },
                { id: 'dal-makhani', name: 'Dal Makhani', price: 240, desc: 'Slow-cooked black lentils', available: true },
                { id: 'paneer-butter', name: 'Paneer Butter Masala', price: 280, desc: 'Paneer in rich tomato gravy', available: true },
                { id: 'biryani-chicken', name: 'Chicken Biryani', price: 300, desc: 'Fragrant rice with spiced chicken', available: true },
                { id: 'biryani-veg', name: 'Veg Biryani', price: 240, desc: 'Fragrant rice with mixed vegetables', available: true },
            ]
        },
        {
            id: 'breads',
            name: '🫓 Breads',
            items: [
                { id: 'butter-naan', name: 'Butter Naan', price: 50, desc: '', available: true },
                { id: 'garlic-naan', name: 'Garlic Naan', price: 60, desc: '', available: true },
                { id: 'tandoori-roti', name: 'Tandoori Roti', price: 30, desc: '', available: true },
            ]
        },
        {
            id: 'beverages',
            name: '🥤 Beverages',
            items: [
                { id: 'masala-chai', name: 'Masala Chai', price: 40, desc: '', available: true },
                { id: 'lassi-sweet', name: 'Sweet Lassi', price: 80, desc: '', available: true },
                { id: 'cold-coffee', name: 'Cold Coffee', price: 120, desc: '', available: true },
            ]
        },
    ]
}, 'main');

console.log('✅ Seed data written to plugins/restaurant/data/');
console.log('   Edit data/config.json to add admin phone numbers.');
