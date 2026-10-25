export type Unit = 'm' | 'ft';

export interface Point {
  x: number;
  y: number;
}

export interface Wall {
  id: string;
  start: Point;
  end: Point;
  thickness: number;
}

export interface Door {
  id: string;
  x: number;
  y: number;
  width: number;
  rotation: number;
  swingDirection: 'left' | 'right';
  wallId?: string;
}

export interface WindowItem {
  id: string;
  x: number;
  y: number;
  width: number;
  thickness: number;
  rotation: number;
  wallId?: string;
}

export type FurnitureCategory = 'beds' | 'tables' | 'seating' | 'custom';

export type CustomShapeKind =
  | 'rect'
  | 'rounded_rect'
  | 'ellipse'
  | 'triangle'
  | 'right_triangle'
  | 'l_shape'
  | 'u_shape'
  | 'pentagon'
  | 'hexagon'
  | 'octagon'
  | 'polygon';

export interface CustomShapeData {
  shape?: CustomShapeKind;
  /** Normalized vertices in [-0.5, 0.5] */
  points?: Point[];
}

export interface FurnitureCatalogItem extends CustomShapeData {
  catalogId: string;
  name: string;
  category: FurnitureCategory;
  width: number;
  depth: number;
  color: string;
  iconType: string;
  description: string;
}

export interface PlacedFurniture extends CustomShapeData {
  id: string;
  catalogId: string;
  name: string;
  category: FurnitureCategory;
  x: number;
  y: number;
  width: number;
  depth: number;
  rotation: number;
  color: string;
  iconType: string;
}

export interface Measurement {
  id: string;
  start: Point;
  end: Point;
}

export interface RoomLabel {
  id: string;
  name: string;
  dimensionsText?: string;
  x: number;
  y: number;
}

export interface TextBoxItem {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  color: string;
  backgroundColor: string;
  borderColor: string;
  borderStyle: 'solid' | 'dashed' | 'none';
  borderRadius: number;
  rotation: number;
  textAlign: 'left' | 'center' | 'right';
  bold?: boolean;
  italic?: boolean;
}

export interface BackgroundLayer {
  dataUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  visible: boolean;
}

export type ToolMode =
  | 'select'
  | 'wall'
  | 'door'
  | 'window'
  | 'text'
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
  roomLabels?: RoomLabel[];
  textBoxes?: TextBoxItem[];
  unit: Unit;
  gridSnap: boolean;
  gridSize: number;
  background?: BackgroundLayer | null;
}

export type SelectedElementType =
  | 'furniture'
  | 'wall'
  | 'door'
  | 'window'
  | 'measurement'
  | 'textbox'
  | 'multiple'
  | null;
