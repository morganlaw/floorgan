import React, { useEffect, useState } from 'react';
import { Armchair, Bed, Shapes, Search, Plus, Pencil, Trash2 } from 'lucide-react';
import { FURNITURE_CATALOG } from '../catalog';
import {
  FurnitureCatalogItem,
  FurnitureCategory,
  PlacedFurniture,
  FloorplanState,
  SelectedElementType,
} from '../types';
import { formatDimension } from '../utils/geometry';
import { TableIcon } from './icons/TableIcon';
import { ShapeThumbnail } from './ShapeBody';
import { CustomObjectCreator } from './CustomObjectCreator';

const CUSTOM_CATALOG_KEY = 'floorgan_custom_catalog_v1';

interface SidebarProps {
  state: FloorplanState;
  setState: React.Dispatch<React.SetStateAction<FloorplanState>>;
  setSelectedId: (id: string | null) => void;
  setSelectedType: (type: SelectedElementType) => void;
}

interface CategoryOption {
  id: FurnitureCategory | 'all';
  label: string;
  icon: React.ReactNode;
}

export const Sidebar: React.FC<SidebarProps> = ({
  state,
  setState,
  setSelectedId,
  setSelectedType,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<FurnitureCategory | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const [customItems, setCustomItems] = useState<FurnitureCatalogItem[]>(() => {
    try {
      const saved = sessionStorage.getItem(CUSTOM_CATALOG_KEY);
      const parsed = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<FurnitureCatalogItem | null>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(CUSTOM_CATALOG_KEY, JSON.stringify(customItems));
    } catch (e) {
      console.warn('Could not save custom catalog to sessionStorage', e);
    }
  }, [customItems]);

  const categories: CategoryOption[] = [
    { id: 'all', label: 'All Items', icon: null },
    { id: 'beds', label: 'Beds', icon: <Bed size={15} /> },
    { id: 'tables', label: 'Tables', icon: <TableIcon size={15} /> },
    { id: 'seating', label: 'Chairs & Sofas', icon: <Armchair size={15} /> },
    { id: 'custom', label: 'Custom', icon: <Shapes size={15} /> },
  ];

  const allItems = [...FURNITURE_CATALOG, ...customItems];
  const query = searchQuery.trim().toLowerCase();
  const filteredItems = allItems.filter((item) => {
    const matchesCategory = selectedCategory === 'all' || item.category === selectedCategory;
    const matchesSearch =
      !query || item.name.toLowerCase().includes(query) || item.category.includes(query);
    return matchesCategory && matchesSearch;
  });

  const handleAddFurniture = (catalogItem: FurnitureCatalogItem) => {
    const newPlacedItem: PlacedFurniture = {
      id: `furn_${Date.now()}`,
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
      ...(catalogItem.shape ? { shape: catalogItem.shape } : {}),
      ...(catalogItem.points ? { points: catalogItem.points.map((p) => ({ ...p })) } : {}),
    };

    setState((prev) => ({
      ...prev,
      furniture: [...prev.furniture, newPlacedItem],
    }));

    setSelectedId(newPlacedItem.id);
    setSelectedType('furniture');
  };

  const openCreator = (item: FurnitureCatalogItem | null = null) => {
    setEditingItem(item);
    setCreatorOpen(true);
  };

  const handleSaveCustom = (item: FurnitureCatalogItem, placeNow: boolean) => {
    setCustomItems((prev) =>
      prev.some((i) => i.catalogId === item.catalogId)
        ? prev.map((i) => (i.catalogId === item.catalogId ? item : i))
        : [...prev, item]
    );

    setState((prev) => ({
      ...prev,
      furniture: prev.furniture.map((f) =>
        f.catalogId === item.catalogId
          ? {
              ...f,
              name: item.name,
              color: item.color,
              width: item.width,
              depth: item.depth,
              ...(item.shape ? { shape: item.shape } : {}),
              ...(item.points ? { points: item.points.map((p) => ({ ...p })) } : {}),
            }
          : f
      ),
    }));

    setCreatorOpen(false);
    setEditingItem(null);
    setSelectedCategory('custom');
    setSearchQuery('');
    if (placeNow) handleAddFurniture(item);
  };

  const handleDeleteCustom = (catalogId: string) => {
    setCustomItems((prev) => prev.filter((i) => i.catalogId !== catalogId));
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2 className="sidebar-title">Furniture Catalog</h2>
        <span className="sidebar-badge">{filteredItems.length} items</span>
      </div>

      <div className="search-box">
        <Search size={16} className="search-icon" />
        <input
          type="text"
          placeholder="Search catalog"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="search-input"
        />
      </div>

      <div className="category-chips">
        {categories.map((cat) => (
          <button
            key={cat.id}
            className={`chip-btn ${selectedCategory === cat.id ? 'active' : ''}`}
            onClick={() => setSelectedCategory(cat.id)}
          >
            {cat.icon}
            <span>{cat.label}</span>
            {cat.id === 'custom' && customItems.length > 0 && (
              <span className="chip-count">{customItems.length}</span>
            )}
          </button>
        ))}
      </div>

      <div className="catalog-grid">
        <div className="custom-actions-bar">
          <button
            className="create-custom-btn w-full"
            onClick={() => openCreator()}
            title="Create custom object shape"
          >
            <Plus size={14} />
            <span>Create Custom Shape</span>
          </button>
        </div>

        {selectedCategory === 'custom' && customItems.length === 0 && (
          <div className="catalog-empty">
            Create custom furniture shapes to add to your floorplan.
          </div>
        )}

        {filteredItems.map((item) => {
          const isCustom = item.category === 'custom';
          return (
            <div
              key={item.catalogId}
              className="catalog-card"
              onClick={() => handleAddFurniture(item)}
              title={item.description || `Click to place ${item.name}`}
            >
              <div className="catalog-card-preview" style={{ backgroundColor: `${item.color}22` }}>
                {item.shape ? (
                  <ShapeThumbnail
                    shape={item.shape}
                    points={item.points}
                    width={item.width}
                    depth={item.depth}
                    color={item.color}
                    size={40}
                  />
                ) : (
                  <div
                    className="furniture-preview-box"
                    style={{
                      width: Math.min(Math.max((item.width / 220) * 54, 24), 60),
                      height: Math.min(Math.max((item.depth / 220) * 54, 18), 50),
                      backgroundColor: item.color,
                      borderRadius: item.iconType === 'table_round' ? '50%' : 0,
                    }}
                  />
                )}
              </div>
              <div className="catalog-card-info">
                <span className="item-name">
                  {item.name}
                  {isCustom && <span className="custom-tag">Custom</span>}
                </span>
                <span className="item-dims">
                  {formatDimension(item.width, state.unit)} × {formatDimension(item.depth, state.unit)}
                </span>
              </div>
              {isCustom && (
                <div className="catalog-card-actions">
                  <button
                    className="card-action-btn"
                    title="Edit custom object"
                    onClick={(e) => {
                      e.stopPropagation();
                      openCreator(item);
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    className="card-action-btn danger"
                    title="Remove from catalog"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteCustom(item.catalogId);
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )}
              <button className="add-btn" title="Add to floorplan">
                <Plus size={14} />
              </button>
            </div>
          );
        })}
      </div>

      <CustomObjectCreator
        isOpen={creatorOpen}
        unit={state.unit}
        editingItem={editingItem}
        onClose={() => {
          setCreatorOpen(false);
          setEditingItem(null);
        }}
        onSave={handleSaveCustom}
      />
    </aside>
  );
};
