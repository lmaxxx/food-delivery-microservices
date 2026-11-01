import { DEMO } from '@food/contracts';

const [pizza, sushi] = DEMO.restaurants;

export const SEED = [
  {
    id: pizza.restaurantId,
    ownerId: pizza.ownerId,
    name: 'Forno Kyiv',
    cuisine: 'Italian',
    lat: 50.4501,
    lng: 30.5234,
    menu: [
      { id: 'pizza-margherita', name: 'Margherita', description: 'Tomato, mozzarella, basil', priceCents: 1100 },
      { id: 'pizza-diavola', name: 'Diavola', description: 'Spicy salami, chili, mozzarella', priceCents: 1350 },
      { id: 'pasta-carbonara', name: 'Carbonara', description: 'Guanciale, egg, pecorino', priceCents: 1250 },
    ],
  },
  {
    id: sushi.restaurantId,
    ownerId: sushi.ownerId,
    name: 'Dnipro Sushi',
    cuisine: 'Japanese',
    lat: 50.4547,
    lng: 30.5166,
    menu: [
      { id: 'roll-salmon', name: 'Salmon roll', description: 'Salmon, avocado, rice', priceCents: 1400 },
      { id: 'roll-tuna', name: 'Spicy tuna roll', description: 'Tuna, sriracha, cucumber', priceCents: 1500 },
      { id: 'ramen-tonkotsu', name: 'Tonkotsu ramen', description: 'Pork broth, noodles, egg', priceCents: 1300 },
    ],
  },
];
