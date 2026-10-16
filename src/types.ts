export type Unit = 'm' | 'ft';

export interface Point {
  x: number; // in centimeters
  y: number; // in centimeters
}

export interface Wall {
  id: string;
  start: Point;
  end: Point;
  thickness: number; // in centimeters (default: 15cm)
}

export interface Door {
  id: string;
  x: number; // center x in cm
  y: number; // center y in cm
  width: number; // width in cm (default: 80cm)
  rotation: number; // in degrees
  swingDirection: 'left' | 'right';
  wallId?: string;
}

export interface WindowItem {
  id: string;
  x: number; // center x in cm
  y: number; // center y in cm
  width: number; // width in cm (default: 100cm)
  thickness: number; // thickness in cm (default: 15cm)
  rotation: number; // in degrees
  wallId?: string;
}

export type FurnitureCategory = 'beds' | 'tables' | 'seating' | 'desks';

export interface FurnitureCatalogItem {
  catalogId: string;
  name: string;
  category: FurnitureCategory;
  width: number; // in cm
  depth: number; // in cm
  color: string;
  iconType: string;
  description: string;
}

export interface PlacedFurniture {
  id: string;
  catalogId: string;
  name: string;
  category: FurnitureCategory;
  x: number; // center x in cm
  y: number; // center y in cm
  width: number; // in cm
  depth: number; // in cm
  rotation: number; // in degrees
  color: string;
  iconType: string;
}

export interface Measurement {
  id: string;
  start: Point;
  end: Point;
}

export interface BackgroundLayer {
  dataUrl: string;
  x: number; // top-left x in cm
  y: number; // top-left y in cm
  width: number; // width in cm
  height: number; // height in cm
  opacity: number; // 0.0 to 1.0
  visible: boolean;
}

export type ToolMode =
  | 'select'
  | 'wall'
  | 'door'
  | 'window'
  | 'measure'
  | 'calibrate'
  | 'pan'
  | 'eraser';

export interface FloorplanState {
  walls: Wall[];
  doors: Door[];
  windows: WindowItem[];
  furniture: PlacedFurniture[];
  measurements: Measurement[];
  unit: Unit;
  gridSnap: boolean;
  gridSize: number; // in cm (e.g. 20cm or 50cm)
  background?: BackgroundLayer | null;
}
