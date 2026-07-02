import garriImage from "../assets/garri.jpg";
import eluboImage from "../assets/elubo.jpeg";
import eluboIsuImage from "../assets/elubo-isu.jpeg";
import palmOilImage from "../assets/palm-oil.jpeg";
import honeyImage from "../assets/honey.jpg";
import oriImage from "../assets/ori.jpeg";

/**
 * The backend owns product data.
 * The frontend owns static images.
 */
const productImageMap = {
  Garri: garriImage,
  Elubo: eluboImage,
  "Elubo Isu": eluboIsuImage,
  "Yam Flour": eluboIsuImage,
  "Palm Oil": palmOilImage,
  Honey: honeyImage,
  Ori: oriImage,
  "Ori (Shea Butter)": oriImage,
};

export function getProductImage(productName) {
  return productImageMap[productName] || garriImage;
}