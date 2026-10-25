# Floorgan

m7w.ca/floorgan

## Model

Floorgan uses a `ConvNeXt-Small + UNet` semantic segmentation model trained on the CubiCasa5K dataset to detect walls, windows, and doors directly in the browser via ONNX WebAssembly. The model's predictions are then traced into clean, editable walls and openings with automatic door swing detection and room scale estimation.

### Performance

| Metric | Score |
| :--- | :---: |
| **Wall Pixel IoU** | 82.5% |
| **Window Pixel IoU** | 81.2% |
| **Door Pixel IoU** | 71.5% |
| **Mean 3-Class Pixel IoU** | 77.7% |
| **Wall Vector F1** *(Precision / Recall)* | 93.8% *(96.3% / 92.1%)* |
| **Door Detection F1** | 96.4% |
| **Door Swing Direction Accuracy** | 89.2% |
| **Window Detection F1** | 92.3% |

## License & Attribution

* **Source Code:** Licensed under the [MIT License](./LICENSE).
* **Pretrained Model Weights (`public/models/floorplan-seg-v1.onnx*`):** Trained on the [CubiCasa5K dataset](https://github.com/CubiCasa/CubiCasa5k) (Kalervo et al., *"CubiCasa5K: A Dataset and an Improved Multi-Task Model for Floorplan Image Analysis"*, SCIA 2019) and distributed under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/).
* **Model Architecture & Runtime:** Built with [`timm`](https://github.com/huggingface/pytorch-image-models) / Meta AI `ConvNeXt` (Apache-2.0 / MIT), [`segmentation_models.pytorch`](https://github.com/qubvel-org/segmentation_models.pytorch) (MIT), and [`onnxruntime-web`](https://github.com/microsoft/onnxruntime) (MIT).
