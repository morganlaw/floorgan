import React, { useState } from 'react';
import {
  Armchair,
  Bed,
  Utensils,
  Briefcase,
  Bath,
  Search,
  Plus,
} from 'lucide-react';
import { FURNITURE_CATALOG } from '../catalog';
import {
  FurnitureCatalogItem,
  FurnitureCategory,
  PlacedFurniture,
  FloorplanState,
} from '../types';
import { formatDimension } from '../utils/geometry';

interface Props {
  state: FloorplanState;
  setState: React.Dispatch<React.SetStateAction<FloorplanState>>;
  setSelectedId: (id: string | null) => void;
  setSelectedType: (type: 'furniture') => void;
}

export const Sidebar: React.FC<Props> = ({
  state,
  setState,
  setSelectedId,
  setSelectedType,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<FurnitureCategory | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const categories = [
    { id: 'all', label: 'All Items', icon: null },
    { id: 'living', label: 'Living', icon: <Armchair size={15} /> },
    { id: 'bedroom', label: 'Bedroom', icon: <Bed size={15} /> },
    { id: 'dining', label: 'Dining', icon: <Utensils size={15} /> },
    { id: 'office', label: 'Office', icon: <Briefcase size={15} /> },
    { id: 'fixtures', label: 'Fixtures', icon: <Bath size={15} /> },
  ];

  const filteredItems = FURNITURE_CATALOG.filter((item) => {
    const matchesCategory = selectedCategory === 'all' || item.category === selectedCategory;
    const matchesSearch = item.name.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  const handleAddFurniture = (catalogItem: FurnitureCatalogItem) => {
    // Place at canvas center or offset based on existing items
    const newPlacedItem: PlacedFurniture = {
      id: 'furn_' + Date.now(),
      catalogId: catalogItem.catalogId,
      name: catalogItem.name,
      category: catalogItem.category,
      x: 400 + (state.furniture.length % 5) * 20,
      y: 350 + (state.furniture.length % 5) * 20,
      width: catalogItem.width,
      depth: catalogItem.depth,
      rotation: 0,
      color: catalogItem.color,
      iconType: catalogItem.iconType,
    };

    setState((prev) => ({
      ...prev,
      furniture: [...prev.furniture, newPlacedItem],
    }));

    setSelectedId(newPlacedItem.id);
    setSelectedType('furniture');
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2 className="sidebar-title">Furniture & Fixtures</h2>
        <span className="sidebar-badge">{filteredItems.length} items</span>
      </div>

      {/* Search Input */}
      <div className="search-box">
        <Search size={16} className="search-icon" />
        <input
          type="text"
          placeholder="Search catalog (sofa, bed, table)..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="search-input"
        />
      </div>

      {/* Category Pills */}
      <div className="category-chips">
        {categories.map((cat) => (
          <button
            key={cat.id}
            className={`chip-btn ${selectedCategory === cat.id ? 'active' : ''}`}
            onClick={() => setSelectedCategory(cat.id as any)}
          >
            {cat.icon}
            <span>{cat.label}</span>
          </button>
        ))}
      </div>

      {/* Item List */}
      <div className="catalog-grid">
        {filteredItems.map((item) => (
          <div
            key={item.catalogId}
            className="catalog-card"
            onClick={() => handleAddFurniture(item)}
            title={`Click to place ${item.name}`}
          >
            <div className="catalog-card-preview" style={{ backgroundColor: item.color + '22' }}>
              <div
                className="furniture-preview-box"
                style={{
                  width: Math.min(Math.max((item.width / 220) * 54, 24), 60),
                  height: Math.min(Math.max((item.depth / 220) * 54, 18), 50),
                  backgroundColor: item.color,
                  borderRadius: 4,
                }}
              />
            </div>
            <div className="catalog-card-info">
              <span className="item-name">{item.name}</span>
              <span className="item-dims">
                {formatDimension(item.width, state.unit)} × {formatDimension(item.depth, state.unit)}
              </span>
            </div>
            <button className="add-btn" title="Add to floorplan">
              <Plus size={14} />
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
};
