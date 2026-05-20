extends StaticBody2D

func _ready() -> void:
	setup_collision(64.0, 64.0)

func setup_collision(width: float, height: float) -> void:
	var shape := RectangleShape2D.new()
	shape.size = Vector2(width, height)
	var collision := CollisionShape2D.new()
	collision.shape = shape
	add_child(collision)
