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

export type FurnitureCategory = 'beds' | 'tables' | 'seating' | 'custom';

/** Basic parametric shapes plus 'polygon' for freeform shapes drawn in the advanced editor */
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

/** Optional geometry for custom-created objects */
export interface CustomShapeData {
  shape?: CustomShapeKind;
  /** Normalized vertices in [-0.5, 0.5] (scaled by width/depth). Used when shape === 'polygon'. */
  points?: Point[];
}

export interface FurnitureCatalogItem extends CustomShapeData {
  catalogId: string;
  name: string;
  category: FurnitureCategory;
  width: number; // in cm
  depth: number; // in cm
  color: string;
  iconType: string;
  description: string;
}

export interface PlacedFurniture extends CustomShapeData {
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

export interface RoomLabel {
  id: string;
  name: string;
  dimensionsText?: string;
  x: number; // center x in cm
  y: number; // center y in cm
}

export interface TextBoxItem {
  id: string;
  text: string;
  x: number; // center x in cm
  y: number; // center y in cm
  width: number; // width in cm
  height: number; // height in cm
  fontSize: number; // font size
  color: string; // text color
  backgroundColor: string; // background fill ('transparent' or hex)
  borderColor: string; // border outline
  borderStyle: 'solid' | 'dashed' | 'none';
  borderRadius: number; // corner radius in px
  rotation: number; // in degrees
  textAlign: 'left' | 'center' | 'right';
  bold?: boolean;
  italic?: boolean;
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
  gridSize: number; // in cm (e.g. 20cm or 50cm)
  background?: BackgroundLayer | null;
}
