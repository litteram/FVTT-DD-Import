Hooks.on("renderSidebarTab", async (app, html) => {
  if (app.options.id == "scenes") {
    let button = $("<button class='import-dd'><i class='fas fa-file-import'></i> Universal Battlemap Import</button>")

    button.click(function () {
      new DDImporter().render(true);
    });

    html.find(".directory-footer").append(button);
  }
})

Hooks.on("init", () => {
  game.settings.register("dd-import", "importSettings", {
    name: "Dungeondraft Default Path",
    scope: "world",
    config: false,
    default: {
      source: "data",
      bucket: "",
      region: "",
      path: "worlds/" + game.world.id + "/stages",
      offset: 0.0,
      fidelity: 3,
      multiImageMode: "g",
      webpConversion: true,
      wallsAroundFiles: true,
      useCustomPixelsPerGrid: false,
      defaultCustomPixelsPerGrid: 100,
    }
  })

  game.settings.register("dd-import", "openableWindows", {
    name: "Openable Windows",
    hint: "Should windows be openable? Note that you can make portals import as windows by unchecking 'block light' in Dungeondraft",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  })
})




class DDImporter extends FormApplication {


  static get defaultOptions() {
    const options = super.defaultOptions;
    options.id = "dd-importer";
    options.template = "modules/dd-import/importer.html"
    options.classes.push("dd-importer");
    options.resizable = false;
    options.height = "auto";
    options.width = 400;
    options.minimizable = true;
    options.title = "Universal Battlemap Importer"
    return options;
  }


  getData() {
    let data = super.getData();
    let settings = game.settings.get("dd-import", "importSettings")

    data.dataSources = {
      data: "User Data",
      s3: "S3"
    }
    data.defaultSource = settings.source || "data";

    data.s3Bucket = settings.bucket || "";
    data.s3Region = settings.region || "";
    data.path = settings.path || "";
    data.offset = settings.offset || 0;
    data.padding = settings.padding || 0.25

    data.multiImageModes = {
      "g": "Grid",
      "y": "Vertical",
      "x": "Horizontal",
    }
    data.multiImageMode = settings.multiImageMode || "g";
    data.webpConversion = settings.webpConversion;
    data.wallsAroundFiles = settings.wallsAroundFiles;

    data.useCustomPixelsPerGrid = settings.useCustomPixelsPerGrid;
    data.defaultCustomPixelsPerGrid = settings.defaultCustomPixelsPerGrid || 100;
    return data
  }

  async _updateObject(event, formData) {
    try {
      let sceneName = formData["sceneName"]
      let fidelity = parseInt(formData["fidelity"])
      let offset = parseFloat(formData["offset"])
      let padding = parseFloat(formData["padding"])
      let source = formData["source"]
      let bucket = formData["bucket"]
      let region = formData["region"]
      let path = formData["path"]
      let mode = formData["multi-mode"]
      let objectWalls = formData["object-walls"]
      let wallsAroundFiles = formData["walls-around-files"]
      let imageFileName = formData["imageFileName"]
      let useCustomPixelsPerGrid = formData["use-custom-gridPPI"]
      let customPixelsPerGrid = formData["customGridPPI"] * 1

      if ((!bucket || !region) && source == "s3")
        return ui.notifications.error("Bucket and Region required for S3 upload")

      let files = []
      for (const file of this.element.find("[name=files]")[0].files) {
        files.push(file)
      }

      // sort by filename
      files.sort((prev, next) => {
        const a = prev.name.toUpperCase()
        const b = next.name.toUpperCase()
        if (a < b)
          return -1
        if (a > b)
          return 1
        return 0
      })

      // File names
      let fileName = DDImporter.fileBasename(files[0].name);
      if (files.length > 1) {
        ui.notifications.notify("Combining images may take quite some time, be patient")
        fileName = "combined-" + Array.prototype.map.call(files, (f) => f.name).join("-")
      }

      // Redundant, set by the UI automatically
      if (!imageFileName.length) {
        fileName = imageFileName
      }

      // lets use the first filename for the scene
      if (sceneName.length == 0) {
        sceneName = fileName
      }

      // read and parse files as JSON, parse images as Blob
      files = await Promise
        .all(files.map((file) => file.text()))
        .then(data => data.map(JSON.parse))
        .then(data => data.map(item => {
          item.image = DDImporter.b64ToBlob(item.image)
          return item
        }))
        .catch(e => console.error("Error parsing files.", e))

      // keep the original filename if it is only one file at all
      if (files.length == 0) {
        ui.notifications.error("Skipped all files while importing or no file has been selected.")
        throw new Error("Skipped all files");
      }

      // determine the pixels per grid value to use
      let pixelsPerGrid = useCustomPixelsPerGrid
          ? customPixelsPerGrid
          : files[0].resolution.pixels_per_grid

      console.log("Grid PPI = ", pixelsPerGrid)

      // do the placement math
      let size = {}
      size.x = files[0].resolution.map_size.x
      size.y = files[0].resolution.map_size.y
      let grid_size = { 'x': size.x, 'y': size.y }
      size.x = size.x * pixelsPerGrid
      size.y = size.y * pixelsPerGrid

      let count = files.length
      var width, height, gridw, gridh
      // respect the stitching mode
      if (mode == 'y') {
        // vertical stitching
        gridw = grid_size.x
        gridh = count * grid_size.y
        for (var f = 0; f < files.length; f++) {
          files[f].pos_in_image = { "x": 0, "y": f * size.y }
          files[f].pos_in_grid = { "x": 0, "y": f * grid_size.y }
        }
      } else if (mode == 'x') {
        // horizontal stitching
        for (var f = 0; f < files.length; f++) {
          files[f].pos_in_image = { "y": 0, "x": f * size.x }
          files[f].pos_in_grid = { "y": 0, "x": f * grid_size.x }
        }
        gridw = count * grid_size.x
        gridh = grid_size.y
      } else if (mode == 'g') {
        // grid is the most complicated one
        // we count the rows, as we fill them up first, e.g. 5 images will end up in 2 rows, the first with 3 the second with two images.
        var vcount = 0
        var hcount = count
        var index = 0
        let hwidth = Math.ceil(Math.sqrt(count))
        // continue as there are images left
        while (hcount > 0) {
          var next_v_index = index + hwidth
          // fill up each row, until all images are placed
          while (index < Math.min(next_v_index, files.length)) {
            files[index].pos_in_image = { y: vcount * size.y,
                                          x: (index - vcount * hwidth) * size.x }
            files[index].pos_in_grid = { y: vcount * grid_size.y,
                                         x: (index - vcount * hwidth) * grid_size.x }
            index += 1
          }
          hcount -= hwidth
          vcount += 1
        }
        gridw = hwidth * grid_size.x
        gridh = vcount * grid_size.y
      }
      width = gridw * pixelsPerGrid
      height = gridh * pixelsPerGrid
      //placement math done.

      // This code works for both single files and multiple files and supports resizing during scene generation
      // Use a canvas to place the image in case we need to convert something
      let thecanvas = document.createElement('canvas');
      thecanvas.width = width;
      thecanvas.height = height;

      let ctx = thecanvas.getContext("2d");
      ui.notifications.notify("Processing " + files.lenght + " Images")

      for (const [idx, file] of files.entries()) {
        ui.notifications.notify("Processing " + (idx + 1) + " of " + files.length + " images")

        const img = await DDImporter.loadImageBlob(file.image)
        const imageWidth = pixelsPerGrid * file.resolution.map_size.x
        const imageHeight = pixelsPerGrid * file.resolution.map_size.y

        await ctx.drawImage(img, file.pos_in_image.x, file.pos_in_image.y, imageWidth, imageHeight)
      }

      ui.notifications.notify("Uploading image: " + fileName)

      let buf = await DDImporter.canvas2buffer(thecanvas, "image/webp")
      let uploading = DDImporter.uploadFile(buf, fileName, path, source, "webp", bucket)

      // aggregate the walls and place them right
      let aggregated = {
        format: 0.2,
        resolution: {
          map_origin: { x: files[0].resolution.map_origin.x,
                        y: files[0].resolution.map_origin.y },
          map_size: { x: gridw,
                      y: gridh },
          pixels_per_grid: pixelsPerGrid,
        },
        line_of_sight: [],
        portals: [],
        environment: files[0].environment,
        lights: [],
      }

      // adapt the walls
      for (const f of files) {
        if (objectWalls)
          f.line_of_sight = f.line_of_sight.concat(f.objects_line_of_sight || [])
        f.line_of_sight.forEach(function (los) {
          los.forEach(function (z) {
            z.x += f.pos_in_grid.x
            z.y += f.pos_in_grid.y
          })
        })
        f.portals.forEach(function (port) {
          port.position.x += f.pos_in_grid.x
          port.position.y += f.pos_in_grid.y
          port.bounds.forEach(function (z) {
            z.x += f.pos_in_grid.x
            z.y += f.pos_in_grid.y
          })
        })
        f.lights.forEach(function (port) {
          port.position.x += f.pos_in_grid.x
          port.position.y += f.pos_in_grid.y
        })

        aggregated.line_of_sight = aggregated.line_of_sight.concat(f.line_of_sight)
        //Add wall around the image
        if (wallsAroundFiles && files.length > 1) {
          aggregated.line_of_sight.push(
            [
              { x: f.pos_in_grid.x,
                y: f.pos_in_grid.y },
              { x: f.pos_in_grid.x + f.resolution.map_size.x,
                y: f.pos_in_grid.y },
              { x: f.pos_in_grid.x + f.resolution.map_size.x,
                y: f.pos_in_grid.y + f.resolution.map_size.y },
              { x: f.pos_in_grid.x,
                y: f.pos_in_grid.y + f.resolution.map_size.y },
              { x: f.pos_in_grid.x,
                y: f.pos_in_grid.y }
            ])
        }
        aggregated.lights = aggregated.lights.concat(f.lights)
        aggregated.portals = aggregated.portals.concat(f.portals)
      }

      ui.notifications.notify("Prepared files uploading ...")
      await uploading

      ui.notifications.notify("creating scene")
      DDImporter.DDImport(aggregated, sceneName, fileName, path, fidelity, offset, padding, "webp", bucket, region, source, pixelsPerGrid)

      game.settings.set("dd-import", "importSettings", {
        source: source,
        bucket: bucket,
        region: region,
        path: path,
        offset: offset,
        padding: padding,
        fidelity: fidelity,
        multiImageMode: mode,
        webpConversion: true,
        wallsAroundFiles: wallsAroundFiles,
      });
    } catch (e) {
      console.error(e)
      ui.notifications.error("Error Importing: " + e)
    }
  }

  activateListeners(html) {
    super.activateListeners(html)

    DDImporter.checkPath(html)
    DDImporter.checkFidelity(html)
    DDImporter.checkSource(html)
    this.setRangeValue(html)


    html.find(".path-input")
        .keyup(ev => DDImporter.checkPath(html))
    html.find(".fidelity-input")
        .change(ev => DDImporter.checkFidelity(html))
    html.find(".source-selector")
        .change(ev => DDImporter.checkSource(html))
    html.find(".padding-input")
        .change(ev => this.setRangeValue(html))

    html.find(".file-input").change(ev => {
      let el = ev.currentTarget

      html.find(".multi-mode-section")[0]
          .style.display = el.files.length > 1 ? "" : "none"

      if (el.files.length) {
        html.find("input[name=imageFileName]")
            .val(DDImporter.fileBasename(el.files[0].name))
      }
    })

    html.find(".use-custom-gridPPI").change(ev => {
      html.find(".custom-gridPPI-section")[0]
          .style.display = ev.currentTarget.checked ? "" : "none"
    })

    html.find(".import-map").click(ev => {})
  }

  setRangeValue(html) {
    let val = html.find(".padding-input").val()
    html.find(".range-value")[0].textContent = val
  }

  static checkPath(html) {
    let pathValue = $("[name='path']")[0].value
    if (pathValue[1] == ":") {
      html.find(".warning.path")[0].style.display = ""
    }
    else
      html.find(".warning.path")[0].style.display = "none"
  }

  static checkFidelity(html) {
    let fidelityValue = $("[name='fidelity']")[0].value
    if (Number(fidelityValue) > 1) {
      html.find(".warning.fidelity")[0].style.display = ""
    }
    else
      html.find(".warning.fidelity")[0].style.display = "none"

  }

  static checkSource(html) {
    let sourceValue = $("[name='source']")[0].value
    if (sourceValue == "s3") {
      html.find(".s3-section")[0].style.display = ""
    }
    else {
      html.find(".s3-section")[0].style.display = "none"
    }

  }

  /* https://developer.mozilla.org/en-US/docs/Glossary/Base64#solution_2_%E2%80%93_rewriting_atob_and_btoa_using_typedarrays_and_utf-8 */
  static base64DecToArr(sBase64, nBlocksSize) {
    function b64ToUint6(nChr) {
      return nChr > 64 && nChr < 91
        ? nChr - 65
        : nChr > 96 && nChr < 123
        ? nChr - 71
        : nChr > 47 && nChr < 58
        ? nChr + 4
        : nChr === 43
        ? 62
        : nChr === 47
        ? 63
        : 0;
    }

    const sB64Enc = sBase64.replace(/[^A-Za-z0-9+/]/g, "");
    const nInLen = sB64Enc.length;
    const nOutLen = nBlocksSize
          ? Math.ceil(((nInLen * 3 + 1) >> 2) / nBlocksSize) * nBlocksSize
          : (nInLen * 3 + 1) >> 2;
    const taBytes = new Uint8Array(nOutLen);

    let nMod3;
    let nMod4;
    let nUint24 = 0;
    let nOutIdx = 0;
    for (let nInIdx = 0; nInIdx < nInLen; nInIdx++) {
      nMod4 = nInIdx & 3;
      nUint24 |= b64ToUint6(sB64Enc.charCodeAt(nInIdx)) << (6 * (3 - nMod4));
      if (nMod4 === 3 || nInLen - nInIdx === 1) {
        nMod3 = 0;
        while (nMod3 < 3 && nOutIdx < nOutLen) {
          taBytes[nOutIdx] = (nUint24 >>> ((16 >>> nMod3) & 24)) & 255;
          nMod3++;
          nOutIdx++;
        }
        nUint24 = 0;
      }
    }

    return taBytes;
  }

  static getImageType(bytes) {
    let magic = bytes.substr(0, 4);
    console.log(magic);
    if (magic == "\u0089PNG") {
      return 'png'
    } else if (magic == "RIFF") {
      return 'webp';
    } else if (magic == "\u00ff\u00d8\u00ff\u00e0") {
      return 'jpeg';
    }
    return 'png';
  }

  /**
   * returns a promise of the canvas blob as an ArrayBuffer
   */
  static canvas2buffer(canvas, type) {
    return new Promise((resolve) => {
      canvas.toBlob(resolve, type)
    })
      .then(blob => blob.arrayBuffer())
  }

  static b64ToBlob(data) {
    const rawdata = DDImporter.base64DecToArr(data)
    const header = Array.prototype.map.call(rawdata.subarray(0,4), (ch) => String.fromCharCode(ch)).join('');
    const imageType = DDImporter.getImageType(header)

    return new Blob([rawdata], {
      type: "image/" + imageType,
    })
  }

  static loadImageBlob(blob) {
    return new Promise((resolve, reject) => {
      const image = new Image()

      image.addEventListener('load', () =>{
        URL.revokeObjectURL(blob)
        resolve(image)
      })

      image.addEventListener('error', (e) => {
        URL.revokeObjectURL(blob)
        reject(e)
      })

      image.src = URL.createObjectURL(blob)
    })
  }

  /**
   * Writes a b64 image
   */
  static async image2Canvas(ctx, file, image_type, imageWidth, imageHeight) {
    image_type = DDImporter.getImageType(atob(file.image.substr(0, 8)));

    const img = new Image()
    img.decoding = "sync"
    img.src = "data:image/" + image_type + ";base64," + file.image
    await img.decode()
    return ctx.drawImage(img, file.pos_in_image.x, file.pos_in_image.y, imageWidth, imageHeight)
  }

  static uploadFile(buffer, name, path, source, image_type, bucket) {
    const f = new File(
      [buffer],
      name + "." + image_type,
      { type: 'image/' + image_type },
    )

    return FilePicker
      .upload(source, path, f, { bucket: bucket })
  }

  static async DDImport(file, sceneName, fileName, path, fidelity, offset, padding, extension, bucket, region, source, pixelsPerGrid) {
    if (path && path[path.length - 1] != "/")
      path = path + "/"
    let imagePath = path + fileName + "." + extension;
    if (source === "s3") {
      if (imagePath[0] != "/")
        imagePath = "/" + imagePath
      imagePath = "https://" + bucket + ".s3." + region + ".amazonaws.com" + imagePath;
    }

    let newScene = new Scene({
      name: sceneName,
      grid: pixelsPerGrid,
      img: imagePath,
      width: pixelsPerGrid * file.resolution.map_size.x,
      height: pixelsPerGrid * file.resolution.map_size.y,
      padding: padding,
      shiftX: 0,
      shiftY: 0
    })

    newScene.updateSource({
      walls: this.GetWalls(file, newScene, 6 - fidelity, offset, pixelsPerGrid).concat(this.GetDoors(file, newScene, offset, pixelsPerGrid)).map(i => i.toObject()),
      lights: this.GetLights(file, newScene, pixelsPerGrid).map(i => i.toObject())
    })

    //mergeObject(newScene.data, {walls: walls.concat(doors), lights: lights})
    //
    let scene = await Scene.create(newScene.toObject());
    let thumb = await scene.createThumbnail()
    return scene.update({ thumb: thumb.thumb })
  }

  static GetWalls(file, scene, skipNum, offset, pixelsPerGrid) {
    let walls = [];
    let ddWalls = file.line_of_sight

    for (let wsIndex = 0; wsIndex < ddWalls.length; wsIndex++) {
      let wallSet = ddWalls[wsIndex]
      // Find walls that directly end on this walls endpoints. So we can close walls, after applying offets
      let connectTo = []
      let connectedTo = []
      for (let i = 0; i < ddWalls.length; i++) {

        if (i == wsIndex) continue
        if (wallSet[wallSet.length - 1].x == ddWalls[i][0].x && wallSet[wallSet.length - 1].y == ddWalls[i][0].y) {
          connectTo.push(ddWalls[i][0])
        }
        if (wallSet[0].x == ddWalls[i][ddWalls[i].length - 1].x && wallSet[0].y == ddWalls[i][ddWalls[i].length - 1].y) {
          connectedTo.push(wallSet[0])
        }
      }

      if (offset != 0) {
        wallSet = this.makeOffsetWalls(wallSet, offset)
      }
      wallSet = this.preprocessWalls(wallSet, skipNum)
      // Connect to walls that end *before* the current wall
      for (let i = 0; i < connectedTo.length; i++) {
        if (DDImporter.isWithinMap(file, connectedTo[i]) || DDImporter.isWithinMap(file, wallSet[0]))
          walls.push(this.makeWall(file, scene, connectedTo[i], wallSet[0], pixelsPerGrid))
      }
      for (let i = 0; i < wallSet.length - 1; i++) {
        if (DDImporter.isWithinMap(file, wallSet[i]) || DDImporter.isWithinMap(file, wallSet[i + 1]))
          walls.push(this.makeWall(file, scene, wallSet[i], wallSet[i + 1], pixelsPerGrid))
      }
      // Connect to walls that end *after* the current wall
      for (let i = 0; i < connectTo.length; i++) {
        if (DDImporter.isWithinMap(file, wallSet[wallSet.length - 1]) || DDImporter.isWithinMap(file, connectTo[i]))
          walls.push(this.makeWall(file, scene, wallSet[wallSet.length - 1], connectTo[i], pixelsPerGrid))
      }
    }

    return walls.filter(w => w)
  }

  static makeWall(file, scene, pointA, pointB, pixelsPerGrid) {
    let sceneDimensions = scene.getDimensions()
    let offsetX = sceneDimensions.sceneX
    let offsetY = sceneDimensions.sceneY
    let originX = file.resolution.map_origin.x
    let originY = file.resolution.map_origin.y

    try {
      return new WallDocument({
        c: [
          ((pointA.x - originX) * pixelsPerGrid) + offsetX,
          ((pointA.y - originY) * pixelsPerGrid) + offsetY,
          ((pointB.x - originX) * pixelsPerGrid) + offsetX,
          ((pointB.y - originY) * pixelsPerGrid) + offsetY
        ]
      })
    }
    catch (e) {
      console.error("Could not create Wall Document: " + e)
    }
  }

  static preprocessWalls(wallSet, numToSkip) {
    let toRemove = [];
    let skipCounter = 0;
    for (let i = 0; i < wallSet.length - 2; i++) {
      if (i != 0 && i != wallSet.length - 2 && this.distance(wallSet[i], wallSet[i + 1]) < 0.3) {
        if (skipCounter == numToSkip) {
          skipCounter = 0;
        }
        else {
          skipCounter++;
          toRemove.push(i);
        }
      }
      else
        skipCounter = 0;
    }
    if (toRemove.length) {
      for (let i = toRemove.length - 1; i > 0; i--) {
        wallSet.splice(toRemove[i], 1)
      }
    }
    return wallSet
  }

  static makeOffsetWalls(wallSet, offset, shortWallThreshold = 0.3, shortWallAmountThreshold = 70) {
    let wallinfo = [];
    let shortWalls = this.GetShortWallCount(wallSet, shortWallThreshold);
    // Assume short wallsets or containing long walls are not caves.
    let shortWallAmount = Math.round((shortWalls / wallSet.length) * 100);
    if (wallSet.length < 10 || shortWallAmount < shortWallAmountThreshold) {
      return wallSet
    }
    // connect the ends if they match
    if (wallSet[0].x == wallSet[wallSet.length - 1].x && wallSet[0].y == wallSet[wallSet.length - 1].y) {
      wallSet.push(wallSet[1]);
      wallSet.push(wallSet[2]);
    }
    for (let i = 0; i < wallSet.length - 1; i++) {
      let slope;
      let myoffset;
      let woffset;
      let m;
      if ((wallSet[i + 1].x - wallSet[i].x) == 0) {
        slope = undefined;
        myoffset = offset;
        if (wallSet[i + 1].y < wallSet[i].y) {
          myoffset = -myoffset;
        }
        woffset = { x: myoffset, y: 0 }
        m = 0;
      } else {
        slope = ((wallSet[i + 1].y - wallSet[i].y) / (wallSet[i + 1].x - wallSet[i].x))
        let dir = (wallSet[i + 1].x - wallSet[i].x) >= 0;
        woffset = this.GetOffset(slope, offset, dir);
        m = wallSet[i].x + woffset.x - wallSet[i].y + woffset.y
      }
      let x = wallSet[i].x + woffset.x
      let y = wallSet[i].y + woffset.y
      wallinfo.push({
        x: x,
        y: y,
        slope: slope,
        m: m
      })
    }
    let newWallSet = []
    for (let i = 0; i < wallSet.length - 2; i++) {
      newWallSet.push(this.interception(wallinfo[i], wallinfo[i + 1]));
    }
    return newWallSet
  }

  static GetShortWallCount(wallSet, shortWallThreshold) {
    let shortCount = 0;
    for (let i = 0; i < wallSet.length - 1; i++) {
      if (this.distance(wallSet[i], wallSet[i + 1]) < shortWallThreshold) {
        shortCount++;
      }
    }
    return shortCount
  }

  static GetOffset(slope, offset, dir) {
    let yoffset = Math.sqrt((offset * offset) / (1 + slope * slope));
    let xoffset = slope * yoffset;
    if ((slope <= 0 && dir) || (slope > 0 && dir)) {
      return { x: xoffset, y: -yoffset }
    }
    return { x: -xoffset, y: yoffset }
  }

  static interception(wallinfo1, wallinfo2) {
    /*
     * x = (m2-m1)/(k1-k2)
     * y = k1*x + m1
     */
    if (wallinfo1.slope == undefined && wallinfo2.slope == undefined) {
      return { x: wallinfo1.x, y: (wallinfo1.y + wallinfo2.y) / 2 }
    }
    else if (wallinfo1.slope == undefined) {
      let m2 = wallinfo2.y - wallinfo2.slope * wallinfo2.x
      return { x: wallinfo1.x, y: wallinfo2.slope * wallinfo1.x + m2 }
    }
    else if (wallinfo2.slope == undefined) {
      let m1 = wallinfo1.y - wallinfo1.slope * wallinfo1.x
      return { x: wallinfo2.x, y: wallinfo1.slope * wallinfo2.x + m1 }
    }
    /* special case if we skipped a short wall, which leads to two parallel walls,
     * or we have a straight wall with multiple points. */
    else if (wallinfo1.slope == wallinfo2.slope) {
      if (wallinfo1.slope == 0) {
        return { x: wallinfo1.x + (wallinfo2.x - wallinfo1.x) / 2, y: wallinfo1.y }
      } else {
        return { x: wallinfo1.x, y: wallinfo1.y + (wallinfo2.y - wallinfo1.y) / 2 }
      }

    }
    let m1 = wallinfo1.y - wallinfo1.slope * wallinfo1.x
    let m2 = wallinfo2.y - wallinfo2.slope * wallinfo2.x
    let x = (m2 - m1) / (wallinfo1.slope - wallinfo2.slope)
    return { x: x, y: wallinfo1.slope * x + m1 }
  }

  static distance(p1, p2) {
    return Math.sqrt(Math.pow((p1.x - p2.x), 2) + Math.pow((p1.y - p2.y), 2))
  }

  static GetDoors(file, scene, offset, pixelsPerGrid) {
    let doors = [];
    let ddDoors = file.portals;
    let sceneDimensions = scene.getDimensions()
    let offsetX = sceneDimensions.sceneX
    let offsetY = sceneDimensions.sceneY

    if (offset != 0) {
      ddDoors = this.makeOffsetWalls(ddDoors, offset)
    }
    for (let door of ddDoors) {
      try {

        doors.push(new WallDocument({
          c: [
            (door.bounds[0].x * pixelsPerGrid) + offsetX,
            (door.bounds[0].y * pixelsPerGrid) + offsetY,
            (door.bounds[1].x * pixelsPerGrid) + offsetX,
            (door.bounds[1].y * pixelsPerGrid) + offsetY
          ],
          door: game.settings.get("dd-import", "openableWindows") ? 1 : (door.closed ? 1 : 0), // If openable windows - all portals should be doors, otherwise, only portals that "block light" should be openable (doors)
          sense: (door.closed) ? CONST.WALL_SENSE_TYPES.NORMAL : CONST.WALL_SENSE_TYPES.NONE
        }))
      }
      catch(e)
      {
        console.error("Could not create Wall Document (door): " + e)
      }
    }

    return doors.filter(d => d)
  }

  static GetLights(file, scene, pixelsPerGrid) {
    let lights = [];
    let sceneDimensions = scene.getDimensions()
    let offsetX = sceneDimensions.sceneX
    let offsetY = sceneDimensions.sceneY
    for (let light of file.lights) {
      if (DDImporter.isWithinMap(file, light.position)) {
        try {
          let newLight = new AmbientLightDocument({
            t: "l",
            x: ((light.position.x - file.resolution.map_origin.x) * pixelsPerGrid) + offsetX,
            y: ((light.position.y - file.resolution.map_origin.y) * pixelsPerGrid) + offsetY,
            rotation: 0,
            dim: light.range * 4,
            bright: light.range * 2,
            angle: 360,
            tintColor: "#" + light.color.substring(2),
            tintAlpha: (0.05 * light.intensity)
          })
          lights.push(newLight);
        }
        catch(e)
        {
          console.error("Could not create AmbientLight Document: " + e)
        }
      }
    }
    return lights.filter(l => l);
  }

  /**
   * Checks if point is within map crop
   *
   * @param {Object} file uvtt file
   * @param {Object} position {x, y}
   * @returns
   */
  static isWithinMap(file, position) {

    let map_originX = file.resolution.map_origin.x
    let map_originY = file.resolution.map_origin.y

    let map_sizeX = file.resolution.map_size.x
    let map_sizeY = file.resolution.map_size.y


    let within;

    if (
      position.x >= map_originX &&
        position.x <= map_originX + map_sizeX &&
        position.y >= map_originY &&
        position.y <= map_originY + map_sizeY)
      within = true
    else within = false

    return within
  }

  static fileBasename(filename) {
    return filename.split(".")[0]
  }
}
