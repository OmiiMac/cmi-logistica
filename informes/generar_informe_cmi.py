# -*- coding: utf-8 -*-
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
                                HRFlowable, ListFlowable, ListItem)

OUT = r"C:\Users\omiim\OneDrive\Desktop\Informe_CMI_Avances_17-18oct2026.pdf"

RED_BRIGHT = colors.HexColor("#ED3B43")
RED_DARK   = colors.HexColor("#8E1F2B")
RED_BRAND  = colors.HexColor("#9B1B30")
INK        = colors.HexColor("#1A1A1A")
MUTED      = colors.HexColor("#555555")

PAGE_W, PAGE_H = A4

def draw_logo(c, x_left, y_top, scale):
    """Dibuja el logo CMI (edificio + texto) con la geometria del SVG original.
    x_left,y_top = esquina superior izquierda en puntos; svg y es top-down."""
    def X(sx): return x_left + sx*scale
    def Y(sy): return y_top - sy*scale   # flip vertical
    def poly(pts, col):
        c.setFillColor(col); p=c.beginPath()
        p.moveTo(X(pts[0][0]), Y(pts[0][1]))
        for sx,sy in pts[1:]: p.lineTo(X(sx), Y(sy))
        p.close(); c.drawPath(p, fill=1, stroke=0)
    def rect(sx,sy,w,h,col):
        c.setFillColor(col); c.rect(X(sx), Y(sy+h), w*scale, h*scale, fill=1, stroke=0)
    # techo
    poly([(150,300),(452,300),(452,182),(150,252)], RED_BRIGHT)
    poly([(470,300),(645,300),(645,252),(470,182)], RED_DARK)
    # filas de ventanas
    for sy,h in [(315,95),(430,95),(545,95),(660,82)]:
        rect(150,sy,302,h,RED_BRIGHT)
        rect(470,sy,175,h,RED_DARK)
    # texto
    c.setFillColor(RED_DARK)
    c.setFont("Helvetica-Bold", 238*scale)
    c.drawString(X(688), Y(520), "CMI")
    c.setFillColor(INK)
    c.setFont("Helvetica", 42*scale)
    c.drawString(X(692), Y(606), "CONSTRUCTIONS CORP")

def first_page(c, doc):
    c.saveState()
    # banda superior (logo centrado verticalmente, con aire sobre la linea)
    draw_logo(c, 36, PAGE_H-15, 0.105)
    c.setFillColor(RED_BRAND)
    c.setFont("Helvetica-Bold", 16)
    c.drawRightString(PAGE_W-36, PAGE_H-42, "Informe de Avances")
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 9.5)
    c.drawRightString(PAGE_W-36, PAGE_H-56, "Plataforma ObraControl CMI")
    c.setStrokeColor(RED_BRAND); c.setLineWidth(2)
    c.line(36, PAGE_H-104, PAGE_W-36, PAGE_H-104)
    _footer(c)
    c.restoreState()

def later_pages(c, doc):
    c.saveState()
    c.setFillColor(RED_BRAND); c.setFont("Helvetica-Bold", 10)
    c.drawString(36, PAGE_H-40, "CMI Constructions Corp.")
    c.setFillColor(MUTED); c.setFont("Helvetica", 9)
    c.drawRightString(PAGE_W-36, PAGE_H-40, "Informe de Avances · ObraControl CMI")
    c.setStrokeColor(colors.HexColor("#E2E1DE")); c.setLineWidth(1)
    c.line(36, PAGE_H-48, PAGE_W-36, PAGE_H-48)
    _footer(c)
    c.restoreState()

def _footer(c):
    c.setFillColor(MUTED); c.setFont("Helvetica", 8)
    c.drawString(36, 24, "CMI Construction Corp. — Documento de uso interno")
    c.drawRightString(PAGE_W-36, 24, "Pagina %d" % c.getPageNumber())

styles = getSampleStyleSheet()
H1 = ParagraphStyle('H1', parent=styles['Heading1'], fontName='Helvetica-Bold',
                    fontSize=13, textColor=RED_BRAND, spaceBefore=14, spaceAfter=6, leading=16)
SUB = ParagraphStyle('SUB', parent=styles['Normal'], fontName='Helvetica', fontSize=9.5,
                     textColor=MUTED, leading=13)
BODY = ParagraphStyle('BODY', parent=styles['Normal'], fontName='Helvetica', fontSize=10,
                      textColor=INK, leading=14, alignment=TA_LEFT, spaceAfter=4)
BUL = ParagraphStyle('BUL', parent=BODY, leftIndent=4, spaceAfter=2)
TITLE = ParagraphStyle('TITLE', parent=styles['Title'], fontName='Helvetica-Bold',
                       fontSize=20, textColor=INK, spaceAfter=2, leading=24)

def bullets(items):
    return ListFlowable(
        [ListItem(Paragraph(t, BUL), leftIndent=10, value='•') for t in items],
        bulletType='bullet', start='•', leftIndent=12, bulletColor=RED_BRAND, spaceAfter=6)

story = []
story.append(Spacer(1, 78))
story.append(Paragraph("Informe de Avances — Plataforma ObraControl CMI", TITLE))
story.append(Paragraph("Preparado para: Direccion de CMI Constructions Corp.  &nbsp;|&nbsp;  "
                       "Periodo: 17 y 18 de octubre de 2026", SUB))
story.append(Spacer(1,10))
story.append(HRFlowable(width="100%", thickness=0.6, color=colors.HexColor("#E2E1DE")))
story.append(Spacer(1,8))

story.append(Paragraph("Resumen ejecutivo", H1))
story.append(Paragraph(
    "En estas dos jornadas se estabilizo la plataforma tras una interrupcion del acceso, "
    "se amplio de forma significativa su alcance operativo y se unifico su imagen corporativa. "
    "La herramienta quedo operativa, mas completa y preparada para el uso diario de los equipos "
    "de obra, logistica, contabilidad, licitaciones y mercadeo, con un panel de control que "
    "resume toda la operacion.", BODY))

story.append(Paragraph("1. Disponibilidad y acceso seguro", H1))
story.append(bullets([
    "Se resolvio una falla que impedia iniciar sesion y crear cuentas; el acceso quedo restablecido y verificado.",
    "Control de acceso por niveles: un <b>Administrador principal</b> con visibilidad total, y la posibilidad de crear un "
    "<b>Administrador secundario</b> con permisos operativos pero sin acceso a Contabilidad (configurable por area).",
    "Gestion de usuarios desde el panel: aprobar o rechazar solicitudes, asignar roles, restablecer contraseñas, "
    "eliminar un usuario puntual o reiniciar todas las cuentas conservando la del administrador.",
    "Recuperacion de contraseña por correo electronico (autoservicio)."]))

story.append(Paragraph("2. Inventario con trazabilidad real", H1))
story.append(bullets([
    "El inventario quedo <b>vinculado a los proyectos</b>: cada vale de salida o entrada descuenta del origen y suma en el "
    "destino automaticamente, manteniendo el conteo de bodega y de cada proyecto siempre actualizado.",
    "Resumen consolidado por articulo (cuanto hay en bodega, cuanto en proyectos y el total).",
    "Identificacion visual: foto por articulo y color por categoria (equipos, herramientas, pinturas, materiales).",
    "Vales de Salida/Entrada de equipos con el formato de CMI, imprimibles, eligiendo las lineas desde el inventario.",
    "Panel de graficas (por categoria, por ubicacion, por estado) y biblioteca de archivos (manuales, garantias, fotos)."]))

story.append(Paragraph("3. Logistica de rutas del camion", H1))
story.append(bullets([
    "Registro de salidas por <b>semana y por mes</b>, con totales y detalle por dia.",
    "Panel de graficas: rutas por estado, por dia de la semana, por conductor y destinos mas frecuentes.",
    "El correo del conductor se elige de los usuarios registrados (sin tipearlo a mano).",
    "Biblioteca de archivos para guias, remitos y fotos de carga."]))

story.append(Paragraph("4. Contabilidad", H1))
story.append(bullets([
    "Nueva seccion de <b>Pendientes y compromisos mensuales</b> (cuentas por pagar y gastos fijos) con totales, "
    "estados (pendiente/pagado) y alta/edicion.",
    "Acceso restringido a los roles de Contabilidad."]))

story.append(Paragraph("5. Licitaciones y Mercadeo", H1))
story.append(bullets([
    "Ambas areas se volvieron mas dinamicas: <b>panel con graficas</b>, <b>calendario mensual</b> "
    "(fechas limite en Licitaciones; publicaciones en Mercadeo) y <b>biblioteca</b> para subir fotos, archivos y videos.",
    "Licitaciones con estados de color claros: aprobada/adjudicada en verde, rechazada/perdida en rojo, "
    "en revision (pendiente por aprobacion) en amarillo, y flujo de aprobacion para la direccion.",
    "Mercadeo con tablero de pendientes, campañas y publicaciones."]))

story.append(Paragraph("6. Panel de control (Dashboard)", H1))
story.append(bullets([
    "Se actualizo para reflejar toda la operacion: indicadores de inventario, proyectos, rutas, licitaciones y mercadeo.",
    "Seccion de panel dinamico con graficas resumen y listado de licitaciones, mostrando a cada usuario solo lo que le corresponde."]))

story.append(Paragraph("7. Imagen corporativa y experiencia de uso", H1))
story.append(bullets([
    "Identidad visual unificada en la linea de CMI (rojo y negro) con el logo como marca de agua, en todas las pantallas.",
    "Optimizacion para <b>telefono</b> (todo legible y usable) y para <b>pantallas panoramicas de PC</b> (el contenido usa el ancho disponible)."]))

story.append(Paragraph("8. Continuidad y seguridad operativa", H1))
story.append(bullets([
    "La plataforma es autonoma (base de datos propia), sin dependencia de servicios de terceros para su nucleo.",
    "Publicada en la nube con los datos resguardados en almacenamiento persistente.",
    "Se incorporo una proteccion para que, al trabajar desde varias computadoras, no se pisen versiones del sistema."]))

story.append(Spacer(1,6))
story.append(HRFlowable(width="100%", thickness=0.6, color=colors.HexColor("#E2E1DE")))
story.append(Spacer(1,6))
story.append(Paragraph("Estado: la plataforma esta en produccion y operativa. Todos los cambios descritos "
                       "fueron probados y desplegados. Quedan disponibles, a pedido, mejoras opcionales "
                       "(verificacion de dominio de correo propio, graficas por proyecto individual, entre otras).", SUB))

SIGN_NAME = ParagraphStyle('SIGN_NAME', parent=styles['Normal'], fontName='Helvetica-Bold',
                           fontSize=11, textColor=INK, leading=14, spaceBefore=4)
SIGN_ROLE = ParagraphStyle('SIGN_ROLE', parent=styles['Normal'], fontName='Helvetica',
                           fontSize=9.5, textColor=MUTED, leading=12)
story.append(Spacer(1,26))
story.append(HRFlowable(width="42%", thickness=0.8, color=INK, hAlign='LEFT'))
story.append(Spacer(1,3))
story.append(Paragraph("Omar Humberto Lopez-Tirone", SIGN_NAME))
story.append(Paragraph("Desarrollador del sistema operativo", SIGN_ROLE))

doc = SimpleDocTemplate(OUT, pagesize=A4,
                        leftMargin=36, rightMargin=36, topMargin=118, bottomMargin=40,
                        title="Informe de Avances - ObraControl CMI",
                        author="CMI Constructions Corp.")
doc.build(story, onFirstPage=first_page, onLaterPages=later_pages)
print("OK ->", OUT)
