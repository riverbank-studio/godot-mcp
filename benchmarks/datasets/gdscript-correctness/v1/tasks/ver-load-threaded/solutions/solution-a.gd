extends Node

const TEXTURE_PATH := "res://textures/bg.png"
var _texture: Texture2D

func _ready() -> void:
	ResourceLoader.load_threaded_request(TEXTURE_PATH)

func _process(_delta: float) -> void:
	if _texture:
		return
	var status := ResourceLoader.load_threaded_get_status(TEXTURE_PATH)
	if status == ResourceLoader.THREAD_LOAD_LOADED:
		_texture = ResourceLoader.load_threaded_get(TEXTURE_PATH) as Texture2D
		set_process(false)
